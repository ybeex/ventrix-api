import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/index.js';
import { holders } from '../../../db/schema.js';
import type { Actor } from '../../../lib/actor.js';
import { fingerprintOf } from '../../../lib/canonical.js';
import { ConflictError, ForbiddenError, UnprocessableError } from '../../../lib/errors.js';
import { roleHas } from '../../../lib/permissions.js';
import {
  applyStockDelta, checkSnapshot, execute, loadItem, lockCustody, outstandingFor, rec, requireQuantity, resolveLocation, transitionAsset,
  type AssetState, type Condition, type CoreCtx, type OpMeta, type OpResult,
} from '../engine.js';
import type { TxRow } from '../ledger.js';
import { approvalRequired } from '../policy.js';

export interface CheckinInput {
  itemId: string; holderId?: string; quantity?: number; condition?: Condition; jobId?: string; locationId?: string; note?: string;
  snapshotFileId?: string; overrideOverReturn?: boolean;
}

/** PRD §15.2 condition → PRD §12 state. (Condition is also stored on the item, separately — see schema.) */
export const STATE_FOR_CONDITION: Record<Condition, AssetState> = { good: 'available', damaged: 'damaged', needs_inspection: 'under_repair', replaced: 'retired' };

async function validate(tx: Db, actor: Actor, input: CheckinInput) {
  const item = await loadItem(tx, actor.orgId, input.itemId);
  if (item.type === 'consumable') {
    if (input.condition) throw new UnprocessableError('NOT_APPLICABLE', 'Condition applies to tracked assets only');
    if (!input.holderId) throw new UnprocessableError('HOLDER_REQUIRED', 'Say who is returning the items');
    requireQuantity(input.quantity);
  } else if (input.quantity !== undefined && input.quantity !== 1) {
    throw new UnprocessableError('NOT_APPLICABLE', 'A tracked asset is a single unit; omit quantity or use 1');
  }
  return item;
}

export async function checkinRun(tx: Db, ctx: CoreCtx, input: CheckinInput, suffix?: string): Promise<TxRow[]> {
  const { actor } = ctx;
  const item = await validate(tx, actor, input);
  const locationId = await resolveLocation(tx, actor.orgId, item.locationId, input.locationId);
  const snapshotFileId = await checkSnapshot(tx, ctx, 'checkin', input.snapshotFileId);

  if (item.type === 'asset') {
    if (item.assetState !== 'checked_out' || !item.currentHolderId) throw new ConflictError('NOT_CHECKED_OUT', `This asset is ${item.assetState}; it is not checked out`, { state: item.assetState });
    // Whoever hands it back must be whoever has it: the ledger must never name the wrong holder.
    if (input.holderId && input.holderId !== item.currentHolderId) throw new ConflictError('HOLDER_MISMATCH', 'This asset is held by someone else', { currentHolderId: item.currentHolderId });
    const condition = input.condition ?? 'good';
    if (condition === 'replaced' && !ctx.approval && (await approvalRequired(tx, actor, 'retirement'))) {
      // Retiring an asset is an approval-gated action (PRD §32); don't let a return smuggle it past the policy.
      throw new UnprocessableError('RETIREMENT_REQUIRES_APPROVAL', 'Retiring an asset requires approval: check it in as "needs_inspection", then request retirement');
    }
    const to = STATE_FOR_CONDITION[condition];
    const prevHolder = item.currentHolderId;
    const updated = await transitionAsset(tx, actor, item.id, ['checked_out'], to, { condition }, prevHolder);
    if (!updated) throw new ConflictError('NOT_CHECKED_OUT', 'This asset was just returned by someone else');
    return [await rec(tx, ctx, {
      type: 'checkin', itemId: item.id, locationId, quantity: 1, stockDelta: 0, custodyDelta: -1, stateBefore: 'checked_out', stateAfter: to,
      holderId: prevHolder, jobId: item.currentJobId, condition, note: input.note ?? null, snapshotFileId,
    }, suffix)];
  }

  const q = requireQuantity(input.quantity);
  const holderId = input.holderId!;
  const [h] = await tx.select({ id: holders.id }).from(holders).where(and(eq(holders.id, holderId), eq(holders.orgId, actor.orgId))).limit(1);
  if (!h) throw new UnprocessableError('HOLDER_NOT_FOUND', 'Holder not found');

  await lockCustody(tx, item.id, holderId);
  const outstanding = await outstandingFor(tx, actor.orgId, item.id, holderId);
  let custodyDelta = -q;
  let overrideAuthorizedBy: string | null = null;
  if (q > outstanding) {
    if (!input.overrideOverReturn) throw new ConflictError('OVER_RETURN', `This holder has only ${outstanding} outstanding; ${q} returned`, { outstanding, requested: q });
    if (!roleHas(actor.role, 'tx:override')) throw new ForbiddenError('Only supervisors and admins can accept a return larger than what was issued');
    custodyDelta = -outstanding; // custody can reach zero but never go negative; the surplus is recorded as such
    overrideAuthorizedBy = actor.id;
  }
  const change = await applyStockDelta(tx, actor, item.id, q);
  if (!change) throw new ConflictError('ITEM_ARCHIVED', 'This item was archived');
  return [await rec(tx, ctx, {
    type: 'checkin', itemId: item.id, locationId, quantity: q, stockDelta: q, custodyDelta, balanceBefore: change.before, balanceAfter: change.after,
    holderId, jobId: input.jobId ?? null, note: input.note ?? null, snapshotFileId, overrideAuthorizedBy,
    metadata: overrideAuthorizedBy ? { overReturnExcess: q - outstanding } : null,
  }, suffix)];
}

export function checkin(db: Db, actor: Actor, key: string, input: CheckinInput, meta?: OpMeta): Promise<OpResult> {
  return execute(db, actor, {
    metricType: 'checkin', key, fingerprint: fingerprintOf('checkin', input), meta,
    gate: { operation: 'checkin', itemId: input.itemId, payload: { input }, required: (tx) => approvalRequired(tx, actor, 'checkin'), precheck: async (tx) => { await validate(tx, actor, input); } },
    run: (tx, ctx) => checkinRun(tx, ctx, input),
  });
}
