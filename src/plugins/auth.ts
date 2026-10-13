/**
 * Session authentication. Bearer tokens are 256-bit random values; only their SHA-256 hash is
 * stored (Postgres) or used as a cache key (Redis). A request is authenticated by hashing the
 * presented token and looking it up — Redis first (60s), Postgres on a miss.
 *
 * Deactivating a user, changing a role, or logging out invalidates the cache immediately
 * (invalidateUserSessions) so a revoked account loses access at once, not after the TTL.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import type { Cache } from '../lib/resilience/cache.js';
import type { Role } from '../lib/actor.js';
import { UnauthorizedError } from '../lib/errors.js';
import { hashToken } from '../lib/tokens.js';
import { metrics } from '../lib/metrics.js';

export interface AuthedUser {
  id: string;
  orgId: string;
  role: Role;
  sessionId: string;
  kind: 'primary' | 'pin';
  trustedDevice: boolean;
  deviceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

const SESSION_CACHE_SECONDS = 60;
const sessionKey = (hash: string) => `sess:${hash}`;

async function loadSession(db: Db, hash: string): Promise<(AuthedUser & { expiresAt: Date }) | null> {
  const [row] = await db
    .select({
      id: users.id, orgId: users.orgId, role: users.role, sessionId: sessions.id, kind: sessions.kind,
      trustedDevice: sessions.trustedDevice, deviceId: sessions.deviceId, expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
    .limit(1);
  return row ?? null;
}

export async function resolveSession(db: Db, cache: Cache, token: string): Promise<AuthedUser | null> {
  const hash = hashToken(token);
  const cached = await cache.get(sessionKey(hash));
  if (cached) {
    const s = JSON.parse(cached) as AuthedUser & { expiresAt: string };
    if (new Date(s.expiresAt) > new Date()) {
      const { expiresAt: _e, ...user } = s;
      return user;
    }
  }
  const row = await loadSession(db, hash);
  if (!row) return null;
  const ttl = Math.max(1, Math.min(SESSION_CACHE_SECONDS, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)));
  await cache.set(sessionKey(hash), JSON.stringify({ ...row, expiresAt: row.expiresAt.toISOString() }), ttl);
  const { expiresAt: _e, ...user } = row;
  return user;
}

/** Drop cached sessions for one user (after role change / deactivation / password change / logout-all). */
export async function invalidateUserSessions(db: Db, cache: Cache, userId: string): Promise<void> {
  const rows = await db.select({ h: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, userId));
  await cache.del(...rows.map((r) => sessionKey(r.h)));
}

export async function invalidateSessionToken(cache: Cache, tokenHash: string): Promise<void> {
  await cache.del(sessionKey(tokenHash));
}

export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t.length >= 20 && t.length <= 200 ? t : null; // cheap shape check before any lookup
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', undefined);

  /** Runs in `onRequest` — i.e. BEFORE the body is parsed or validated — so unauthenticated callers learn nothing about schemas. */
  app.decorate('authenticate', async function authenticate(req: FastifyRequest) {
    const token = bearerOf(req);
    if (!token) { metrics.authFailures.inc({ reason: 'missing_token' }); throw new UnauthorizedError(); }
    const user = await resolveSession(app.db, app.cache, token);
    if (!user) { metrics.authFailures.inc({ reason: 'invalid_session' }); throw new UnauthorizedError(); }
    req.user = user;
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}
