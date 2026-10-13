import { and, desc, eq, isNull, ne, sql, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { authTokens, holders, organizations, sessions, users } from '../../db/schema.js';
import type { Actor, Role } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import type { Cache } from '../../lib/resilience/cache.js';
import { hashToken, newSessionToken } from '../../lib/tokens.js';
import { env } from '../../env.js';
import { enqueueEmail } from '../mail/outbox.js';
import { inviteEmail } from '../mail/templates.js';
import { invalidateUserSessions } from '../../plugins/auth.js';
import { getSettings } from '../organization/settings.service.js';

const userView = {
  id: users.id, email: users.email, role: users.role, active: users.active,
  hasPassword: sql<boolean>`${users.passwordHash} is not null`,
  hasPin: sql<boolean>`${users.pinHash} is not null`,
  name: holders.name, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt,
};

export async function listUsers(db: Db, orgId: string, q: { role?: Role; active?: boolean; cursor?: string; limit: number }) {
  const rows = await db.select(userView).from(users)
    .leftJoin(holders, and(eq(holders.userId, users.id), eq(holders.orgId, users.orgId)))
    .where(and(
      eq(users.orgId, orgId),
      q.role ? eq(users.role, q.role) : undefined,
      q.active === undefined ? undefined : eq(users.active, q.active),
      q.cursor ? keysetWhere(users.createdAt, users.id, q.cursor) : undefined,
    ))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(q.limit + 1);
  return toPage(rows, q.limit);
}

// ── Role-based invitations ──────────────────────────────────────────
/** Who may invite whom. Admins invite any role; supervisors only store staff and viewers; nobody else invites. */
export const INVITABLE: Record<Role, readonly Role[]> = {
  admin: ['admin', 'supervisor', 'store_staff', 'viewer'],
  supervisor: ['store_staff', 'viewer'],
  store_staff: [],
  viewer: [],
};

async function assertMayHandle(db: Db, actor: Actor, targetRole: Role): Promise<void> {
  if (!INVITABLE[actor.role].includes(targetRole)) throw new ForbiddenError(`Your role cannot invite or manage invitations for ${targetRole.replace('_', ' ')}`);
  if (actor.role === 'supervisor' && !(await getSettings(db, actor.orgId)).supervisorsCanInvite) throw new ForbiddenError('Supervisors are not permitted to invite users in this organization');
}

async function issueInvite(tx: Db, actor: Actor, user: { id: string; email: string; role: Role; orgId: string }) {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actor.orgId)).limit(1);
  const [inviter] = await tx.select({ name: holders.name }).from(holders).where(and(eq(holders.userId, actor.id), eq(holders.orgId, actor.orgId))).limit(1);
  await tx.delete(authTokens).where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, 'invite'), isNull(authTokens.usedAt))); // one live link per invitee
  const token = newSessionToken();
  await tx.insert(authTokens).values({ userId: user.id, purpose: 'invite', tokenHash: hashToken(token), createdBy: actor.id, expiresAt: new Date(Date.now() + env.INVITE_TTL_SECONDS * 1000) });
  await enqueueEmail(tx, { orgId: actor.orgId, to: user.email, ...inviteEmail(org?.name ?? 'your organization', user.role.replace('_', ' '), token, inviter?.name) });
}

export async function inviteUser(db: Db, actor: Actor, input: { email: string; role: Role; name?: string }) {
  await assertMayHandle(db, actor, input.role);
  const email = input.email.trim().toLowerCase();
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(and(eq(users.orgId, actor.orgId), eq(users.email, email))).limit(1);
      let user: typeof users.$inferSelect;
      if (existing) {
        // A REVOKED, never-accepted invitation can be re-issued (possibly with a different role); anything else is a conflict.
        if (existing.passwordHash || existing.active) throw new ConflictError('EMAIL_TAKEN', existing.passwordHash ? 'A user with this email already exists in your organization' : 'This person already has a pending invitation; resend it instead');
        [user] = await tx.update(users).set({ active: true, role: input.role, invitedBy: actor.id, invitedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, existing.id)).returning();
        if (input.name) await tx.update(holders).set({ name: input.name.trim(), updatedAt: new Date() }).where(and(eq(holders.userId, user.id), eq(holders.orgId, actor.orgId)));
      } else {
        [user] = await tx.insert(users).values({ orgId: actor.orgId, email, role: input.role, invitedBy: actor.id, invitedAt: new Date() }).returning();
        await tx.insert(holders).values({ orgId: actor.orgId, kind: 'person', name: input.name?.trim() || email.split('@')[0], userId: user.id, createdBy: actor.id });
      }
      await issueInvite(tx, actor, user);
      await audit(tx, actor, { action: 'user.invited', entityType: 'user', entityId: user.id, next: { email, role: input.role, reissued: !!existing } });
      const [view] = await tx.select(userView).from(users).leftJoin(holders, and(eq(holders.userId, users.id), eq(holders.orgId, users.orgId))).where(eq(users.id, user.id));
      return view;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_org_email_unique')) throw new ConflictError('EMAIL_TAKEN', 'A user with this email already exists in your organization');
    throw err;
  }
}

async function pendingTarget(tx: Db, actor: Actor, userId: string) {
  const [user] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, actor.orgId))).limit(1);
  if (!user || !INVITABLE[actor.role].includes(user.role)) throw new NotFoundError('Invitation'); // a role you may not manage looks like it does not exist
  if (user.passwordHash) throw new ConflictError('ALREADY_ACCEPTED', 'This user has already set a password');
  return user;
}

export async function resendInvite(db: Db, actor: Actor, userId: string) {
  await assertMayHandle(db, actor, (await db.select({ r: users.role }).from(users).where(and(eq(users.id, userId), eq(users.orgId, actor.orgId))).limit(1))[0]?.r ?? 'viewer');
  await db.transaction(async (tx) => {
    const user = await pendingTarget(tx, actor, userId);
    if (!user.active) throw new ConflictError('INVITE_REVOKED', 'This invitation was revoked; invite the person again');
    await issueInvite(tx, actor, user);
    await tx.update(users).set({ invitedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
    await audit(tx, actor, { action: 'user.invite_resent', entityType: 'user', entityId: userId });
  });
}

export async function revokeInvite(db: Db, actor: Actor, userId: string) {
  await assertMayHandle(db, actor, (await db.select({ r: users.role }).from(users).where(and(eq(users.id, userId), eq(users.orgId, actor.orgId))).limit(1))[0]?.r ?? 'viewer');
  await db.transaction(async (tx) => {
    const user = await pendingTarget(tx, actor, userId);
    if (!user.active) throw new ConflictError('INVITE_REVOKED', 'This invitation is already revoked');
    await tx.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.delete(authTokens).where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, 'invite')));
    await audit(tx, actor, { action: 'user.invite_revoked', entityType: 'user', entityId: userId, previous: { role: user.role } });
  });
}

export interface InviteStatusRow { id: string; email: string; role: Role; name: string | null; invitedBy: { id: string; name: string | null } | null; invitedAt: Date | null; expiresAt: Date | null; status: 'pending' | 'expired' | 'revoked' }

/** Pending / expired / revoked invitations the caller is allowed to see (their own manageable roles). Status is DERIVED, never stored. */
export async function listInvitations(db: Db, actor: Actor, q: { status?: 'pending' | 'expired' | 'revoked'; cursor?: string; limit: number }) {
  const roles = INVITABLE[actor.role];
  if (roles.length === 0) return { items: [] as InviteStatusRow[], nextCursor: null as string | null };
  const cur = q.cursor ? Buffer.from(q.cursor, 'base64url').toString().split('|') : null;
  const rows = (await db.execute(sql`
    select * from (
      select u.id, u.email, u.role, u.invited_by, u.invited_at, u.created_at, h.name,
             (select name from holders ih where ih.user_id = u.invited_by and ih.org_id = u.org_id) as inviter_name,
             (select max(t.expires_at) from auth_tokens t where t.user_id = u.id and t.purpose = 'invite' and t.used_at is null) as expires_at,
             case when not u.active then 'revoked'
                  when coalesce((select max(t.expires_at) from auth_tokens t where t.user_id = u.id and t.purpose = 'invite' and t.used_at is null), now() - interval '1 second') < now() then 'expired'
                  else 'pending' end as status
      from users u left join holders h on h.user_id = u.id and h.org_id = u.org_id
      where u.org_id = ${actor.orgId} and u.password_hash is null and u.role in (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})
    ) x
    where true ${q.status ? sql`and x.status = ${q.status}` : sql``} ${cur ? sql`and (x.created_at, x.id) < (${cur[0]}::timestamptz, ${cur[1]}::uuid)` : sql``}
    order by x.created_at desc, x.id desc limit ${q.limit + 1}`)) as unknown as Array<Record<string, any>>;
  const list = Array.isArray(rows) ? rows : (rows as { rows: Array<Record<string, any>> }).rows;
  const hasMore = list.length > q.limit;
  const page = hasMore ? list.slice(0, q.limit) : list;
  const last = page.at(-1);
  return {
    items: page.map((r): InviteStatusRow => ({
      id: r.id, email: r.email, role: r.role, name: r.name, invitedBy: r.invited_by ? { id: r.invited_by, name: r.inviter_name } : null,
      invitedAt: r.invited_at ? new Date(r.invited_at) : null, expiresAt: r.expires_at ? new Date(r.expires_at) : null, status: r.status,
    })),
    nextCursor: hasMore && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

export type BulkResult = { email: string; status: 'invited' | 'exists' | 'forbidden' | 'invalid'; userId?: string; message?: string };

/** Each invitation succeeds or fails on its own; the response says exactly which. */
export async function inviteMany(db: Db, actor: Actor, invites: Array<{ email: string; role: Role; name?: string }>): Promise<BulkResult[]> {
  const seen = new Set<string>();
  const out: BulkResult[] = [];
  for (const inv of invites) {
    const email = inv.email.trim().toLowerCase();
    if (seen.has(email)) { out.push({ email, status: 'invalid', message: 'Listed more than once in this request' }); continue; }
    seen.add(email);
    try {
      const u = await inviteUser(db, actor, inv);
      out.push({ email, status: 'invited', userId: u.id });
    } catch (err) {
      if (err instanceof ForbiddenError) out.push({ email, status: 'forbidden', message: err.message });
      else if (err instanceof ConflictError) out.push({ email, status: 'exists', message: err.message });
      else throw err;
    }
  }
  return out;
}

export async function updateUser(db: Db, cache: Cache, actor: Actor, userId: string, patch: { role?: Role; active?: boolean }) {
  const result = await db.transaction(async (tx) => {
    // Serialise every role/active change within an org so two admins demoting each other
    // concurrently cannot both pass the "is there another admin?" check and leave zero admins.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`admins:${actor.orgId}`}, 0))`);
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, actor.orgId))).limit(1);
    if (!target) throw new NotFoundError('User');

    if (patch.active === false && target.id === actor.id) throw new ConflictError('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');

    const losesAdmin = target.role === 'admin' && target.active && ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false);
    if (losesAdmin) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users)
        .where(and(eq(users.orgId, actor.orgId), eq(users.role, 'admin'), eq(users.active, true), isNotNull(users.passwordHash), ne(users.id, target.id)));
      if (n === 0) throw new ConflictError('LAST_ADMIN', 'The organization must keep at least one active administrator');
    }

    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.role === 'admin') { set.pinHash = null; set.pinFailedAttempts = 0; set.pinLockedUntil = null; } // admins never use PINs
    await tx.update(users).set(set).where(eq(users.id, userId));

    if (patch.active === false || (patch.role !== undefined && patch.role !== target.role)) {
      await invalidateUserSessions(tx as unknown as Db, cache, userId); // cache keys first…
      if (patch.active === false) await tx.delete(sessions).where(eq(sessions.userId, userId)); // …then the sessions themselves
    }
    await audit(tx, actor, {
      action: patch.active === false ? 'user.deactivated' : patch.active === true && !target.active ? 'user.reactivated' : 'user.role_changed',
      entityType: 'user', entityId: userId,
      previous: { role: target.role, active: target.active }, next: { role: patch.role ?? target.role, active: patch.active ?? target.active },
    });
    const [view] = await tx.select(userView).from(users).leftJoin(holders, and(eq(holders.userId, users.id), eq(holders.orgId, users.orgId))).where(eq(users.id, userId));
    return view;
  });
  return result;
}
