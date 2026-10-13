import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { sessions, users } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import type { Cache } from '../../lib/resilience/cache.js';
import { invalidateSessionToken } from '../../plugins/auth.js';

const cols = { id: sessions.id, kind: sessions.kind, trustedDevice: sessions.trustedDevice, deviceId: sessions.deviceId, ip: sessions.ip, userAgent: sessions.userAgent, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt };

export async function listSessions(db: Db, userId: string, currentSessionId?: string) {
  const rows = await db.select(cols).from(sessions).where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date()))).orderBy(desc(sessions.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(), current: r.id === currentSessionId }));
}

/** Sign one session out. Scoped to the target user (and org) so an id from elsewhere can never be revoked. */
export async function revokeSession(db: Db, cache: Cache, actor: Actor, targetUserId: string, sessionId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ hash: sessions.tokenHash, orgId: users.orgId }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, targetUserId), eq(users.orgId, actor.orgId))).limit(1);
    if (!row) throw new NotFoundError('Session');
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await invalidateSessionToken(cache, row.hash);
    await audit(tx, actor, { action: 'session.revoked', entityType: 'user', entityId: targetUserId, next: { sessionId, own: targetUserId === actor.id } });
  });
}

/** Admin: sign a user out of every device at once (lost or stolen tablet, departing employee). */
export async function revokeAllSessions(db: Db, cache: Cache, actor: Actor, targetUserId: string) {
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, targetUserId), eq(users.orgId, actor.orgId))).limit(1);
    if (!u) throw new NotFoundError('User');
    const gone = await tx.delete(sessions).where(eq(sessions.userId, targetUserId)).returning({ hash: sessions.tokenHash });
    for (const g of gone) await invalidateSessionToken(cache, g.hash);
    await audit(tx, actor, { action: 'session.revoked', entityType: 'user', entityId: targetUserId, next: { sessions: gone.length, allDevices: true } });
    return gone.length;
  });
}

export async function listUserSessions(db: Db, orgId: string, userId: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.orgId, orgId))).limit(1);
  if (!u) throw new NotFoundError('User');
  return listSessions(db, userId);
}
