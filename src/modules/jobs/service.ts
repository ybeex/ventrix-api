import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { jobs } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { contains } from '../../lib/sql.js';

export type JobRow = typeof jobs.$inferSelect;

/** PRD §10: a job/site is optional context on a transaction. It must exist in this org and still be active. */
export async function assertUsableJob(db: Db, orgId: string, id: string): Promise<JobRow> {
  const [row] = await db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.orgId, orgId))).limit(1);
  if (!row) throw new UnprocessableError('JOB_NOT_FOUND', 'Job not found');
  if (row.archivedAt || row.status !== 'active') throw new UnprocessableError('JOB_INACTIVE', 'This job is closed or archived');
  return row;
}

export async function createJob(db: Db, actor: Actor, input: { name: string; code?: string }) {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(jobs).values({ orgId: actor.orgId, name: input.name.trim(), code: input.code?.trim() || null }).returning();
      await audit(tx, actor, { action: 'job.created', entityType: 'job', entityId: row.id, next: { name: row.name, code: row.code } });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'jobs_org_code_unique')) throw new ConflictError('JOB_CODE_TAKEN', 'A job with this code already exists');
    throw err;
  }
}

export async function listJobs(db: Db, orgId: string, q: { q?: string; status?: 'active' | 'closed'; includeArchived?: boolean; cursor?: string; limit: number }) {
  const rows = await db.select().from(jobs).where(and(
    eq(jobs.orgId, orgId), q.status ? eq(jobs.status, q.status) : undefined, q.includeArchived ? undefined : isNull(jobs.archivedAt),
    q.q ? or(sql`${jobs.name} ilike ${contains(q.q)}`, sql`${jobs.code} ilike ${contains(q.q)}`) : undefined,
    q.cursor ? keysetWhere(jobs.createdAt, jobs.id, q.cursor) : undefined,
  )).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(q.limit + 1);
  return toPage(rows, q.limit);
}

export async function updateJob(db: Db, actor: Actor, id: string, patch: { name?: string; code?: string | null; status?: 'active' | 'closed' }) {
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.orgId, actor.orgId))).limit(1);
      if (!before) throw new NotFoundError('Job');
      const [after] = await tx.update(jobs).set({
        ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.code !== undefined ? { code: patch.code?.trim() || null } : {}), ...(patch.status ? { status: patch.status } : {}),
      }).where(and(eq(jobs.id, id), eq(jobs.orgId, actor.orgId))).returning();
      await audit(tx, actor, { action: 'job.updated', entityType: 'job', entityId: id, previous: { name: before.name, code: before.code, status: before.status }, next: { name: after.name, code: after.code, status: after.status } });
      return after;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'jobs_org_code_unique')) throw new ConflictError('JOB_CODE_TAKEN', 'A job with this code already exists');
    throw err;
  }
}

export async function archiveJob(db: Db, actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const res = await tx.update(jobs).set({ archivedAt: new Date() }).where(and(eq(jobs.id, id), eq(jobs.orgId, actor.orgId), isNull(jobs.archivedAt))).returning({ id: jobs.id });
    if (res.length === 0) throw new NotFoundError('Job');
    await audit(tx, actor, { action: 'job.archived', entityType: 'job', entityId: id });
  });
}
