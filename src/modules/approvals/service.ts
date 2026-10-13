import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/index.js';
import { holders, items, pendingApprovals } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import type { TxRow } from '../transactions/ledger.js';
import { executeApproved } from '../transactions/approved.js';
import type { ApprovalRow } from './store.js';

const reqHolder = alias(holders, 'req_holder');
const revHolder = alias(holders, 'rev_holder');
const sel = {
  a: pendingApprovals, requesterName: reqHolder.name, reviewerName: revHolder.name, itemName: items.name, itemNumber: items.itemNumber,
};
type Joined = { a: ApprovalRow; requesterName: string | null; reviewerName: string | null; itemName: string | null; itemNumber: string | null };

const base = (db: Db) => db.select(sel).from(pendingApprovals)
  .leftJoin(reqHolder, and(eq(reqHolder.userId, pendingApprovals.requestedBy), eq(reqHolder.orgId, pendingApprovals.orgId)))
  .leftJoin(revHolder, and(eq(revHolder.userId, pendingApprovals.reviewedBy), eq(revHolder.orgId, pendingApprovals.orgId)))
  .leftJoin(items, eq(items.id, pendingApprovals.itemId));

export function serializeApproval(j: Joined) {
  const a = j.a;
  return {
    id: a.id, operation: a.operation, status: a.status,
    item: a.itemId ? { id: a.itemId, name: j.itemName ?? '', itemNumber: j.itemNumber ?? '' } : null,
    request: (a.payload as { input: unknown }).input,
    requestedBy: { id: a.requestedBy, name: j.requesterName },
    reviewedBy: a.reviewedBy ? { id: a.reviewedBy, name: j.reviewerName } : null,
    reviewedAt: a.reviewedAt?.toISOString() ?? null, reviewNote: a.reviewNote, resultingTransactionId: a.resultingTransactionId,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function hydrateApproval(db: Db, orgId: string, a: ApprovalRow) {
  const [j] = await base(db).where(and(eq(pendingApprovals.id, a.id), eq(pendingApprovals.orgId, orgId))).limit(1);
  return serializeApproval(j);
}

/** Store staff see only their own requests; supervisors/admins see the whole queue. */
export async function listApprovals(db: Db, actor: Actor, q: { status?: ApprovalRow['status']; operation?: ApprovalRow['operation']; cursor?: string; limit: number }) {
  const rows = await base(db).where(and(
    eq(pendingApprovals.orgId, actor.orgId), eq(pendingApprovals.status, q.status ?? 'pending'),
    q.operation ? eq(pendingApprovals.operation, q.operation) : undefined,
    actor.role === 'store_staff' ? eq(pendingApprovals.requestedBy, actor.id) : undefined,
    q.cursor ? keysetWhere(pendingApprovals.createdAt, pendingApprovals.id, q.cursor) : undefined,
  )).orderBy(desc(pendingApprovals.createdAt), desc(pendingApprovals.id)).limit(q.limit + 1);
  const page = toPage(rows.map((r) => ({ ...r, id: r.a.id, createdAt: r.a.createdAt })), q.limit);
  return { items: (page.items as Joined[]).map(serializeApproval), nextCursor: page.nextCursor };
}

export async function getApproval(db: Db, actor: Actor, id: string) {
  const [j] = await base(db).where(and(eq(pendingApprovals.id, id), eq(pendingApprovals.orgId, actor.orgId), actor.role === 'store_staff' ? eq(pendingApprovals.requestedBy, actor.id) : undefined)).limit(1);
  if (!j) throw new NotFoundError('Approval');
  return serializeApproval(j);
}

export async function approve(db: Db, actor: Actor, id: string, note?: string): Promise<{ approval: ApprovalRow; rows: TxRow[] }> {
  return db.transaction(async (tx) => {
    // The row lock makes approve/reject/cancel mutually exclusive: whoever arrives second sees a non-pending status.
    const [a] = await tx.select().from(pendingApprovals).where(and(eq(pendingApprovals.id, id), eq(pendingApprovals.orgId, actor.orgId))).for('update');
    if (!a) throw new NotFoundError('Approval');
    if (a.status !== 'pending') throw new ConflictError('APPROVAL_NOT_PENDING', `This request is already ${a.status}`);
    if (a.requestedBy === actor.id) throw new ConflictError('CANNOT_APPROVE_OWN', 'You cannot approve your own request');

    const rows = await executeApproved(tx, a, actor.id, { requestId: actor.requestId, ip: actor.ip }); // throws → whole thing rolls back, stays pending
    const primary = rows.find((r) => r.idempotencyKey === `approval:${a.id}`) ?? rows[0];
    const [approval] = await tx.update(pendingApprovals).set({ status: 'approved', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note ?? null, resultingTransactionId: primary.id })
      .where(eq(pendingApprovals.id, id)).returning();
    await audit(tx, actor, { action: 'approval.approved', entityType: 'approval', entityId: id, transactionId: primary.id, reason: note ?? null });
    await emitEvent(tx, actor.orgId, { type: 'approval.decided', approvalId: id, operation: a.operation, requestedBy: a.requestedBy, decision: 'approved', reviewedBy: actor.id, note: note ?? null });
    return { approval, rows };
  });
}

export async function reject(db: Db, actor: Actor, id: string, note: string): Promise<ApprovalRow> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(pendingApprovals).where(and(eq(pendingApprovals.id, id), eq(pendingApprovals.orgId, actor.orgId))).for('update');
    if (!a) throw new NotFoundError('Approval');
    if (a.status !== 'pending') throw new ConflictError('APPROVAL_NOT_PENDING', `This request is already ${a.status}`);
    const [approval] = await tx.update(pendingApprovals).set({ status: 'rejected', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note }).where(eq(pendingApprovals.id, id)).returning();
    await audit(tx, actor, { action: 'approval.rejected', entityType: 'approval', entityId: id, reason: note });
    await emitEvent(tx, actor.orgId, { type: 'approval.decided', approvalId: id, operation: a.operation, requestedBy: a.requestedBy, decision: 'rejected', reviewedBy: actor.id, note });
    return approval;
  });
}

export async function cancel(db: Db, actor: Actor, id: string): Promise<ApprovalRow> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(pendingApprovals).where(and(eq(pendingApprovals.id, id), eq(pendingApprovals.orgId, actor.orgId), eq(pendingApprovals.requestedBy, actor.id))).for('update');
    if (!a) throw new NotFoundError('Approval');
    if (a.status !== 'pending') throw new ConflictError('APPROVAL_NOT_PENDING', `This request is already ${a.status}`);
    const [approval] = await tx.update(pendingApprovals).set({ status: 'cancelled', reviewedAt: new Date() }).where(eq(pendingApprovals.id, id)).returning();
    await audit(tx, actor, { action: 'approval.cancelled', entityType: 'approval', entityId: id });
    return approval;
  });
}
