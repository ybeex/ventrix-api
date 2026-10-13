/**
 * Pending-approval persistence. Kept free of any dependency on the transaction operations so the
 * operations can create approvals while the approvals service (which EXECUTES approved operations)
 * depends on the operations — no import cycle.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { pendingApprovals } from '../../db/schema.js';
import type { Actor, Role } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';

export type ApprovalRow = typeof pendingApprovals.$inferSelect;
export type ApprovalOperation = ApprovalRow['operation'];
export type ApprovalMode = 'direct' | 'staff_approval' | 'all_approval';

/**
 * PRD §18/§32. direct → nobody waits. staff_approval → store_staff are queued, supervisors/admins commit.
 * all_approval → everyone except admins is queued (admins are the final authority and are never queued).
 */
export function modeRequiresApproval(mode: ApprovalMode, role: Role): boolean {
  if (role === 'admin' || mode === 'direct') return false;
  if (mode === 'staff_approval') return role === 'store_staff';
  return true;
}

export async function findPendingByKey(tx: Db, orgId: string, requesterId: string, key: string): Promise<ApprovalRow | undefined> {
  const [row] = await tx.select().from(pendingApprovals)
    .where(and(eq(pendingApprovals.orgId, orgId), eq(pendingApprovals.requestedBy, requesterId), eq(pendingApprovals.idempotencyKey, key))).limit(1);
  return row;
}

export async function createPending(
  tx: Db, actor: Actor,
  p: { operation: ApprovalOperation; itemId: string | null; payload: unknown; key: string; fingerprint: string },
): Promise<ApprovalRow> {
  const [row] = await tx.insert(pendingApprovals).values({
    orgId: actor.orgId, operation: p.operation, itemId: p.itemId, payload: p.payload, requestedBy: actor.id,
    idempotencyKey: p.key, requestFingerprint: p.fingerprint,
  }).returning();
  await audit(tx, actor, { action: 'approval.requested', entityType: 'approval', entityId: row.id, next: { operation: p.operation, itemId: p.itemId } });
  await emitEvent(tx, actor.orgId, { type: 'approval.requested', approvalId: row.id, operation: p.operation, requestedBy: actor.id, itemId: p.itemId });
  return row;
}
