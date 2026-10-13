import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { users } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { ConflictError } from '../../lib/errors.js';
import type { ApprovalRow } from '../approvals/store.js';
import { getSettings } from '../organization/settings.service.js';
import type { CoreCtx } from './engine.js';
import type { TxRow } from './ledger.js';
import { batchRun, checkoutRun } from './ops/checkout.js';
import { checkinRun } from './ops/checkin.js';
import { adjustRun, conditionRun, lossRun } from './ops/incidents.js';

/**
 * Executes a previously-deferred operation at approval time, inside the reviewer's DB transaction.
 * The ledger names the REQUESTER as actor (they asked for it) and the reviewer as `approved_by`.
 * Everything is re-validated against LIVE state — an approval does not freeze the world: if the stock
 * has gone, the item was archived, or the asset moved on, the approval fails (409/422) and stays pending.
 */
export async function executeApproved(tx: Db, approval: ApprovalRow, reviewerId: string, meta: { requestId?: string; ip?: string }): Promise<TxRow[]> {
  const [requester] = await tx.select().from(users).where(and(eq(users.id, approval.requestedBy), eq(users.orgId, approval.orgId))).limit(1);
  if (!requester || !requester.active) throw new ConflictError('REQUESTER_INACTIVE', 'The person who made this request is no longer active; reject it instead');
  const actor: Actor = { id: requester.id, orgId: requester.orgId, role: requester.role, ...meta };
  const ctx: CoreCtx = {
    actor, key: `approval:${approval.id}`, fingerprint: approval.requestFingerprint ?? '', source: 'online', occurredAt: new Date(), deviceId: null,
    approval: { id: approval.id, by: reviewerId }, settings: await getSettings(tx, approval.orgId),
  };
  const input = (approval.payload as { input: never }).input;
  switch (approval.operation) {
    case 'adjustment': return adjustRun(tx, ctx, input);
    case 'loss': return lossRun(tx, ctx, input);
    case 'retirement': return conditionRun(tx, ctx, input);
    case 'checkout': return checkoutRun(tx, ctx, input);
    case 'checkout_batch': return batchRun(tx, ctx, input);
    case 'checkin': return checkinRun(tx, ctx, input);
  }
}
