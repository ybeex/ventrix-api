import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import {
  approvalPolicies, authTokens, holders, locations, organizations, organizationSettings, sessions, users,
} from '../../db/schema.js';
import { audit, auditSafe } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, UnprocessableError } from '../../lib/errors.js';
import { metrics } from '../../lib/metrics.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import type { Cache } from '../../lib/resilience/cache.js';
import { hashToken, newSessionToken } from '../../lib/tokens.js';
import { isValidTimezone } from '../../lib/time.js';
import { env } from '../../env.js';
import { enqueueEmail } from '../mail/outbox.js';
import { seedDefaultCatalog } from '../shelves/service.js';
import { passwordResetEmail } from '../mail/templates.js';
import { invalidateSessionToken, invalidateUserSessions } from '../../plugins/auth.js';
import { assertPasswordAcceptable, assertPinAcceptable } from './password-policy.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Verified against when the account doesn't exist / can't log in, so "no such user" costs the same time as "wrong password".
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword('timing-equalisation-dummy-password'));

export interface RequestMeta { ip?: string; userAgent?: string; requestId?: string }

export async function createSession(
  tx: Db,
  s: { userId: string; kind?: 'primary' | 'pin'; trustedDevice?: boolean; deviceId?: string | null; parentSessionId?: string | null; ttlSeconds?: number },
  meta: RequestMeta,
) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + (s.ttlSeconds ?? env.SESSION_TTL_SECONDS) * 1000);
  await tx.insert(sessions).values({
    userId: s.userId, tokenHash: hashToken(token), kind: s.kind ?? 'primary', trustedDevice: s.trustedDevice ?? false,
    deviceId: s.deviceId ?? null, parentSessionId: s.parentSessionId ?? null, expiresAt,
    ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

const slugify = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

export interface RegisterOrgInput {
  organizationName: string; slug?: string; timezone?: string; adminName?: string; email: string; password: string; deviceId?: string;
}

export async function registerOrganization(db: Db, input: RegisterOrgInput, meta: RequestMeta) {
  const timezone = input.timezone ?? 'Africa/Lagos';
  if (!isValidTimezone(timezone)) throw new UnprocessableError('INVALID_TIMEZONE', 'Unknown IANA time zone');
  const email = input.email.trim().toLowerCase();
  assertPasswordAcceptable(input.password, email);
  const passwordHash = await hashPassword(input.password);
  const base = input.slug ? slugify(input.slug) : slugify(input.organizationName);

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      return await db.transaction(async (tx) => {
        const [org] = await tx.insert(organizations).values({ name: input.organizationName.trim(), slug, timezone }).returning();
        await tx.insert(organizationSettings).values({ orgId: org.id });
        await tx.insert(approvalPolicies).values({ orgId: org.id });
        const [location] = await tx.insert(locations).values({ orgId: org.id, name: 'Main Store', kind: 'store', isDefault: true }).returning();
        await seedDefaultCatalog(tx, org.id, location.id); // a starting shelf + category, so the first item can be created immediately
        const [user] = await tx.insert(users).values({ orgId: org.id, email, passwordHash, role: 'admin', lastLoginAt: new Date() }).returning();
        await tx.insert(holders).values({ orgId: org.id, kind: 'person', name: input.adminName?.trim() || email.split('@')[0], userId: user.id, createdBy: user.id });
        const session = await createSession(tx, { userId: user.id, deviceId: input.deviceId }, meta);
        await audit(tx, { orgId: org.id, id: user.id, ...meta }, { action: 'org.registered', entityType: 'organization', entityId: org.id, next: { name: org.name, slug, timezone } });
        return { org, user, location, session };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'organizations_slug_unique')) {
        if (input.slug) throw new ConflictError('SLUG_TAKEN', 'That organization identifier is already in use');
        continue;
      }
      throw err;
    }
  }
  throw new ConflictError('SLUG_TAKEN', 'Could not allocate an organization identifier; try a different name');
}

const GENERIC_LOGIN_FAILURE = () => new UnauthorizedError('Invalid credentials');

export async function login(
  db: Db,
  input: { orgSlug: string; email: string; password: string; deviceId?: string; trustDevice?: boolean },
  meta: RequestMeta,
) {
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .select({ user: users, orgId: organizations.id })
    .from(organizations)
    .leftJoin(users, and(eq(users.orgId, organizations.id), eq(users.email, email)))
    .where(eq(organizations.slug, input.orgSlug.trim().toLowerCase()))
    .limit(1);

  const user = row?.user ?? undefined;
  const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
  const usable = !!user && user.active && !!user.passwordHash && !locked;
  const ok = await verifyPassword(usable ? user.passwordHash! : await getDummyHash(), input.password);

  if (!usable || !ok) {
    const reason = locked ? 'locked' : user ? (user.active ? 'bad_password' : 'inactive') : 'unknown_user';
    metrics.authFailures.inc({ reason: locked ? 'locked' : user ? 'bad_password' : 'unknown_user' });
    let justLocked = false;
    if (user && user.active && !locked) {
      // Atomic increment + conditional lock: concurrent guesses cannot slip past the threshold.
      const [u] = await db.update(users).set({
        failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
        lockedUntil: sql`case when ${users.failedLoginAttempts} + 1 >= ${MAX_FAILED_LOGINS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
      }).where(eq(users.id, user.id)).returning({ attempts: users.failedLoginAttempts });
      justLocked = u.attempts === MAX_FAILED_LOGINS;
    }
    // Security log (only when the organization exists — there is nowhere to attribute an attempt on an unknown tenant).
    // The CALLER still gets one generic answer: no account enumeration. Admins get the forensic detail.
    if (row) {
      await auditSafe(db, { orgId: row.orgId, id: null, ...meta }, { action: 'auth.login_failed', entityType: user ? 'user' : 'organization', entityId: user?.id ?? row.orgId, next: { reason, deviceId: input.deviceId ?? null } });
      if (justLocked) await auditSafe(db, { orgId: row.orgId, id: null, ...meta }, { action: 'auth.account_locked', entityType: 'user', entityId: user!.id, next: { minutes: LOCK_MINUTES, after: MAX_FAILED_LOGINS } });
    }
    throw GENERIC_LOGIN_FAILURE();
  }

  const canTrust = user.role === 'admin' || user.role === 'supervisor';
  if (input.trustDevice && !canTrust) throw new ForbiddenError('Only supervisors and admins can register a shared device');

  return db.transaction(async (tx) => {
    await tx.update(users).set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const session = await createSession(tx, { userId: user.id, trustedDevice: !!input.trustDevice, deviceId: input.deviceId }, meta);
    await audit(tx, { orgId: user.orgId, id: user.id, ...meta }, { action: 'auth.login', entityType: 'user', entityId: user.id, next: { deviceId: input.deviceId ?? null, trustedDevice: !!input.trustDevice } });
    return { user, session };
  });
}

export async function logout(db: Db, cache: Cache, actor: { orgId: string; id: string; requestId?: string; ip?: string }, tokenHash: string, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await invalidateSessionToken(cache, tokenHash);
  await auditSafe(db, actor, { action: 'auth.logout', entityType: 'user', entityId: actor.id, next: { sessionId } });
}

export async function logoutAll(db: Db, cache: Cache, actor: { orgId: string; id: string; requestId?: string; ip?: string }) {
  await invalidateUserSessions(db, cache, actor.id); // read hashes BEFORE deleting
  const gone = await db.delete(sessions).where(eq(sessions.userId, actor.id)).returning({ id: sessions.id });
  await auditSafe(db, actor, { action: 'auth.logout_all', entityType: 'user', entityId: actor.id, next: { sessions: gone.length } });
}

/** Single-use token redemption: one atomic UPDATE is the arbiter, so a token can never be used twice, even concurrently. */
async function redeemToken(tx: Db, token: string, purpose: 'invite' | 'password_reset'): Promise<string> {
  const [t] = await tx.update(authTokens).set({ usedAt: new Date() })
    .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .returning({ userId: authTokens.userId });
  if (!t) throw new UnprocessableError('INVALID_TOKEN', 'This link is invalid, expired, or already used');
  return t.userId;
}

export async function acceptInvite(db: Db, input: { token: string; password: string; deviceId?: string }, meta: RequestMeta) {
  return db.transaction(async (tx) => {
    const userId = await redeemToken(tx, input.token, 'invite');
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !user.active) throw new UnprocessableError('INVALID_TOKEN', 'This link is invalid, expired, or already used');
    assertPasswordAcceptable(input.password, user.email);
    await tx.update(users).set({ passwordHash: await hashPassword(input.password), updatedAt: new Date(), lastLoginAt: new Date() }).where(eq(users.id, userId));
    const session = await createSession(tx, { userId, deviceId: input.deviceId }, meta);
    await audit(tx, { orgId: user.orgId, id: userId, ...meta }, { action: 'user.invite_accepted', entityType: 'user', entityId: userId });
    return { user, session };
  });
}

export async function requestPasswordReset(db: Db, input: { orgSlug: string; email: string }, meta: RequestMeta = {}): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const [row] = await db.select({ user: users }).from(organizations)
    .innerJoin(users, and(eq(users.orgId, organizations.id), eq(users.email, email)))
    .where(eq(organizations.slug, input.orgSlug.trim().toLowerCase())).limit(1);
  // Same (202) response whether or not the account exists — the caller learns nothing. Admins can still see the attempt in the security log.
  const [orgRow] = row ? [{ id: row.user.orgId }] : await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, input.orgSlug.trim().toLowerCase())).limit(1);
  if (orgRow) await auditSafe(db, { orgId: orgRow.id, id: null, ...meta }, { action: 'auth.password_reset_requested', entityType: row ? 'user' : 'organization', entityId: row?.user.id ?? orgRow.id, next: { known: !!row } });
  if (!row || !row.user.active || !row.user.passwordHash) return;
  const user = row.user;
  const token = newSessionToken();
  await db.transaction(async (tx) => {
    await tx.delete(authTokens).where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, 'password_reset'), isNull(authTokens.usedAt)));
    await tx.insert(authTokens).values({ userId: user.id, purpose: 'password_reset', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_SECONDS * 1000) });
    await enqueueEmail(tx, { orgId: user.orgId, to: user.email, ...passwordResetEmail(token) });
  });
}

export async function confirmPasswordReset(db: Db, cache: Cache, input: { token: string; password: string }, meta: RequestMeta) {
  const userId = await db.transaction(async (tx) => {
    const id = await redeemToken(tx, input.token, 'password_reset');
    const [user] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user || !user.active) throw new UnprocessableError('INVALID_TOKEN', 'This link is invalid, expired, or already used');
    assertPasswordAcceptable(input.password, user.email);
    await tx.update(users).set({ passwordHash: await hashPassword(input.password), failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, id));
    await audit(tx, { orgId: user.orgId, id, ...meta }, { action: 'user.password_reset', entityType: 'user', entityId: id });
    return id;
  });
  // A password reset signs the account out everywhere (a stolen session must not survive it).
  await invalidateUserSessions(db, cache, userId);
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function changeOwnPin(db: Db, userId: string, input: { password: string; pin: string }, meta: RequestMeta & { orgId: string }) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('User');
  if (user.role === 'admin') throw new ForbiddenError('Admin accounts cannot use a PIN');
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) throw new UnauthorizedError('Current password is incorrect');
  assertPinAcceptable(input.pin);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ pinHash: await hashPassword(input.pin), pinFailedAttempts: 0, pinLockedUntil: null, updatedAt: new Date() }).where(eq(users.id, userId));
    await audit(tx, { id: userId, ...meta }, { action: 'user.pin_set', entityType: 'user', entityId: userId });
  });
}

export async function clearPin(db: Db, orgId: string, targetUserId: string, actor: { id: string; requestId?: string; ip?: string }) {
  await db.transaction(async (tx) => {
    const res = await tx.update(users).set({ pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null, updatedAt: new Date() })
      .where(and(eq(users.id, targetUserId), eq(users.orgId, orgId))).returning({ id: users.id });
    if (res.length === 0) throw new NotFoundError('User');
    await audit(tx, { orgId, ...actor }, { action: 'user.pin_cleared', entityType: 'user', entityId: targetUserId });
  });
}

/** People who can be picked on a shared device: active, non-admin, PIN set. */
export async function listPinUsers(db: Db, orgId: string) {
  return db.select({ userId: users.id, name: holders.name })
    .from(users)
    .innerJoin(holders, and(eq(holders.userId, users.id), eq(holders.orgId, users.orgId)))
    .where(and(eq(users.orgId, orgId), eq(users.active, true), sql`${users.pinHash} is not null`, sql`${users.role} <> 'admin'`))
    .orderBy(holders.name);
}

export async function pinSwitch(
  db: Db,
  caller: { sessionId: string; orgId: string; trustedDevice: boolean; kind: 'primary' | 'pin'; deviceId: string | null },
  input: { userId: string; pin: string },
  meta: RequestMeta,
) {
  // Only a supervisor/admin-registered device session may mint PIN sessions, and a PIN session can never mint more.
  if (caller.kind !== 'primary' || !caller.trustedDevice) throw new ForbiddenError('This device is not registered for PIN sign-in');
  const [target] = await db.select().from(users).where(and(eq(users.id, input.userId), eq(users.orgId, caller.orgId))).limit(1);
  const locked = !!target?.pinLockedUntil && target.pinLockedUntil > new Date();
  const usable = !!target && target.active && target.role !== 'admin' && !!target.pinHash && !locked;
  const ok = await verifyPassword(usable ? target.pinHash! : await getDummyHash(), input.pin);
  if (!usable || !ok) {
    metrics.authFailures.inc({ reason: 'pin_failed' });
    await auditSafe(db, { orgId: caller.orgId, id: null, ...meta }, { action: 'auth.pin_failed', entityType: 'user', entityId: input.userId, next: { deviceId: caller.deviceId } });
    if (target && target.active && !locked) {
      await db.update(users).set({
        pinFailedAttempts: sql`${users.pinFailedAttempts} + 1`,
        pinLockedUntil: sql`case when ${users.pinFailedAttempts} + 1 >= ${MAX_FAILED_LOGINS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.pinLockedUntil} end`,
      }).where(eq(users.id, target.id));
    }
    throw new UnauthorizedError('Invalid PIN');
  }
  return db.transaction(async (tx) => {
    await tx.update(users).set({ pinFailedAttempts: 0, pinLockedUntil: null }).where(eq(users.id, target.id));
    const session = await createSession(tx, { userId: target.id, kind: 'pin', deviceId: caller.deviceId, parentSessionId: caller.sessionId, ttlSeconds: env.PIN_SESSION_TTL_SECONDS }, meta);
    await audit(tx, { orgId: target.orgId, id: target.id, ...meta }, { action: 'auth.pin_switch', entityType: 'user', entityId: target.id, next: { deviceId: caller.deviceId } });
    return { user: target, session };
  });
}
