import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { holderMembers, holders, items, jobs, transactions, users } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { contains } from '../../lib/sql.js';

export type HolderKind = 'person' | 'team' | 'department' | 'job_site' | 'other';
export type HolderRow = typeof holders.$inferSelect;

/** A holder usable as the target of a checkout: exists in this org, not archived, and — if linked to a login — that login is active. */
export async function assertUsableHolder(db: Db, orgId: string, id: string): Promise<HolderRow> {
  const [row] = await db.select({ h: holders, active: users.active }).from(holders)
    .leftJoin(users, eq(users.id, holders.userId))
    .where(and(eq(holders.id, id), eq(holders.orgId, orgId))).limit(1);
  if (!row) throw new UnprocessableError('HOLDER_NOT_FOUND', 'Holder not found');
  if (row.h.archivedAt || row.active === false) throw new UnprocessableError('HOLDER_INACTIVE', 'This holder is archived or deactivated and cannot receive items');
  return row.h;
}

export async function createHolder(db: Db, actor: Actor, input: { kind: HolderKind; name: string; code?: string; jobId?: string }) {
  // Workers (person holders) can be added on the spot by whoever runs the store; teams, departments, sites are admin-curated.
  if (input.kind !== 'person' && actor.role !== 'admin') throw new ForbiddenError('Only administrators can create teams, departments, sites or other holders');
  if (input.jobId && input.kind !== 'job_site') throw new UnprocessableError('JOB_ONLY_FOR_SITE', 'jobId applies only to job/site holders');
  return db.transaction(async (tx) => {
    if (input.jobId) {
      const [j] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.orgId, actor.orgId))).limit(1);
      if (!j) throw new UnprocessableError('JOB_NOT_FOUND', 'Job not found');
    }
    const [row] = await tx.insert(holders).values({ orgId: actor.orgId, kind: input.kind, name: input.name.trim(), code: input.code?.trim() || null, jobId: input.jobId ?? null, createdBy: actor.id }).returning();
    await audit(tx, actor, { action: 'holder.created', entityType: 'holder', entityId: row.id, next: { kind: row.kind, name: row.name } });
    return row;
  });
}

export async function listHolders(db: Db, orgId: string, q: { q?: string; kind?: HolderKind; includeArchived?: boolean; cursor?: string; limit: number }) {
  const rows = await db.select().from(holders).where(and(
    eq(holders.orgId, orgId),
    q.kind ? eq(holders.kind, q.kind) : undefined,
    q.includeArchived ? undefined : isNull(holders.archivedAt),
    q.q ? or(sql`${holders.name} ilike ${contains(q.q)}`, eq(holders.code, q.q.trim())) : undefined,
    q.cursor ? keysetWhere(holders.createdAt, holders.id, q.cursor) : undefined,
  )).orderBy(desc(holders.createdAt), desc(holders.id)).limit(q.limit + 1);
  return toPage(rows, q.limit);
}

export async function getHolder(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(holders).where(and(eq(holders.id, id), eq(holders.orgId, orgId))).limit(1);
  if (!row) throw new NotFoundError('Holder');
  return row;
}

export async function updateHolder(db: Db, actor: Actor, id: string, patch: { name?: string; code?: string | null }) {
  return db.transaction(async (tx) => {
    const before = await getHolder(tx, actor.orgId, id);
    if (before.kind !== 'person' && actor.role !== 'admin') throw new ForbiddenError('Only administrators can edit this kind of holder');
    const [after] = await tx.update(holders).set({
      ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.code !== undefined ? { code: patch.code?.trim() || null } : {}), updatedAt: new Date(),
    }).where(and(eq(holders.id, id), eq(holders.orgId, actor.orgId))).returning();
    await audit(tx, actor, { action: 'holder.updated', entityType: 'holder', entityId: id, previous: { name: before.name, code: before.code }, next: { name: after.name, code: after.code } });
    return after;
  });
}

/** Does anything still sit with this holder? Assets in their custody, or a positive consumable balance in the ledger. */
export async function hasOutstanding(db: Db, orgId: string, holderId: string): Promise<boolean> {
  const [asset] = await db.select({ id: items.id }).from(items)
    .where(and(eq(items.orgId, orgId), eq(items.currentHolderId, holderId), eq(items.assetState, 'checked_out'))).limit(1);
  if (asset) return true;
  const rows = await db.select({ n: sql<number>`sum(${transactions.custodyDelta})::int` }).from(transactions)
    .innerJoin(items, eq(items.id, transactions.itemId))
    .where(and(eq(transactions.orgId, orgId), eq(transactions.holderId, holderId), eq(items.type, 'consumable')))
    .groupBy(transactions.itemId).having(sql`sum(${transactions.custodyDelta}) > 0`).limit(1);
  return rows.length > 0;
}

export async function archiveHolder(db: Db, actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const h = await getHolder(tx, actor.orgId, id);
    if (h.userId) throw new ConflictError('HOLDER_LINKED_TO_USER', 'This holder belongs to a login; deactivate the user instead');
    if (h.kind !== 'person' && actor.role !== 'admin') throw new ForbiddenError('Only administrators can archive this kind of holder');
    if (await hasOutstanding(tx, actor.orgId, id)) throw new ConflictError('HOLDER_HAS_OUTSTANDING', 'This holder still has items checked out; record their return first');
    await tx.update(holders).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(holders.id, id));
    await audit(tx, actor, { action: 'holder.archived', entityType: 'holder', entityId: id });
  });
}

export async function setMembers(db: Db, actor: Actor, teamId: string, personIds: string[]) {
  return db.transaction(async (tx) => {
    const team = await getHolder(tx, actor.orgId, teamId);
    if (team.kind !== 'team' && team.kind !== 'department') throw new UnprocessableError('NOT_A_TEAM', 'Members can only be set on teams and departments');
    const unique = [...new Set(personIds)];
    if (unique.length) {
      const found = await tx.select({ id: holders.id }).from(holders).where(and(inArray(holders.id, unique), eq(holders.orgId, actor.orgId), eq(holders.kind, 'person'), isNull(holders.archivedAt)));
      if (found.length !== unique.length) throw new UnprocessableError('MEMBER_NOT_FOUND', 'Every member must be an active person in your organization');
    }
    const before = await tx.select({ id: holderMembers.personId }).from(holderMembers).where(eq(holderMembers.teamId, teamId));
    await tx.delete(holderMembers).where(eq(holderMembers.teamId, teamId));
    if (unique.length) await tx.insert(holderMembers).values(unique.map((personId) => ({ teamId, personId })));
    await audit(tx, actor, { action: 'holder.members_set', entityType: 'holder', entityId: teamId, previous: before.map((b) => b.id), next: unique });
    return unique;
  });
}

export async function getMembers(db: Db, orgId: string, teamId: string) {
  await getHolder(db, orgId, teamId);
  return db.select({ id: holders.id, name: holders.name }).from(holderMembers)
    .innerJoin(holders, eq(holders.id, holderMembers.personId)).where(eq(holderMembers.teamId, teamId)).orderBy(holders.name);
}

/** Holders this actor recently issued to / took returns from — the shared-device "recently used" shortcut (PRD §49). */
export async function recentHolders(db: Db, actor: Actor, limit: number) {
  return db.select({ id: holders.id, kind: holders.kind, name: holders.name, lastUsedAt: sql<Date>`max(${transactions.createdAt})` })
    .from(transactions).innerJoin(holders, eq(holders.id, transactions.holderId))
    .where(and(eq(transactions.orgId, actor.orgId), eq(transactions.actorUserId, actor.id), isNull(holders.archivedAt), sql`${transactions.createdAt} > now() - interval '30 days'`))
    .groupBy(holders.id).orderBy(desc(sql`max(${transactions.createdAt})`)).limit(limit);
}
