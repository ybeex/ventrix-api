import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/index.js';
import { items } from '../../../db/schema.js';
import type { Actor } from '../../../lib/actor.js';
import { fingerprintOf } from '../../../lib/canonical.js';
import { AppError, ConflictError, ForbiddenError, UnprocessableError } from '../../../lib/errors.js';
import { roleHas } from '../../../lib/permissions.js';
import { assertUsableHolder } from '../../holders/service.js';
import { assertUsableJob } from '../../jobs/service.js';
import {
  applyStockDelta, categoryDefaultReturnHours, checkSnapshot, execute, loadItem, rec, requireQuantity, requireType, resolveLocation,
  stockOrConflict, transitionAsset, type CoreCtx, type OpMeta, type OpResult,
} from '../engine.js';
import type { TxRow } from '../ledger.js';
import { approvalRequired } from '../policy.js';

export interface CheckoutInput {
  itemId: string; holderId: string; quantity?: number; jobId?: string; locationId?: string; purpose?: string; note?: string;
  dueAt?: string; snapshotFileId?: string; override?: boolean;
}

/** Cheap, non-mutating validation shared by the approval gate and the real run. */
async function validate(tx: Db, actor: Actor, input: CheckoutInput) {
  const item = await loadItem(tx, actor.orgId, input.itemId);
  const holder = await assertUsableHolder(tx, actor.orgId, input.holderId);
  const job = input.jobId ? await assertUsableJob(tx, actor.orgId, input.jobId) : null;
  if (item.type === 'consumable') {
    requireQuantity(input.quantity); // a consumable line MAY carry a due date ("return by"); it is not required
  } else if (input.quantity !== undefined && input.quantity !== 1) {
    throw new UnprocessableError('NOT_APPLICABLE', 'A tracked asset is a single unit; omit quantity or use 1');
  }
  return { item, holder, job };
}

export async function checkoutRun(tx: Db, ctx: CoreCtx, input: CheckoutInput, suffix?: string): Promise<TxRow[]> {
  const { actor } = ctx;
  const { item, holder, job } = await validate(tx, actor, input);
  const locationId = await resolveLocation(tx, actor.orgId, item.locationId, input.locationId);
  const snapshotFileId = await checkSnapshot(tx, ctx, 'checkout', input.snapshotFileId);
  const common = { itemId: item.id, locationId, holderId: holder.id, jobId: job?.id ?? null, purpose: input.purpose ?? null, note: input.note ?? null, snapshotFileId };

  if (item.type === 'asset') {
    const at = ctx.occurredAt;
    let dueAt: Date | null = null;
    if (input.dueAt) {
      dueAt = new Date(input.dueAt);
      if (dueAt <= at) throw new UnprocessableError('INVALID_DUE_DATE', 'The due date must be in the future');
    } else {
      const hours = item.expectedReturnHours ?? (await categoryDefaultReturnHours(tx, item.categoryId));
      if (hours) dueAt = new Date(at.getTime() + hours * 3_600_000); // fixed now: a later policy change never rewrites this issue
    }
    const updated = await transitionAsset(tx, actor, item.id, ['available'], 'checked_out', { holderId: holder.id, jobId: job?.id ?? null, checkedOutAt: at, dueAt });
    if (!updated) {
      const cur = await loadItem(tx, actor.orgId, item.id, { allowArchived: true });
      throw new ConflictError('ITEM_NOT_AVAILABLE', cur.archivedAt ? 'This item was archived' : `This asset is ${cur.assetState}, not available`, { state: cur.assetState, currentHolderId: cur.currentHolderId });
    }
    return [await rec(tx, ctx, { ...common, type: 'checkout', quantity: 1, stockDelta: 0, custodyDelta: 1, stateBefore: 'available', stateAfter: 'checked_out', condition: item.condition, dueAt }, suffix)];
  }

  // Consumable — an explicit due date makes this a returnable issue; the line's due date is that of its oldest unreturned issue (FIFO).
  const q = requireQuantity(input.quantity);
  let consumableDue: Date | null = null;
  if (input.dueAt) {
    consumableDue = new Date(input.dueAt);
    if (consumableDue <= ctx.occurredAt) throw new UnprocessableError('INVALID_DUE_DATE', 'The due date must be in the future');
  }
  const out: TxRow[] = [];
  let change = await applyStockDelta(tx, actor, item.id, -q);
  let overrideAuthorizedBy: string | null = null;

  if (!change) {
    if (!input.override) await stockOrConflict(tx, actor, item, -q, q); // throws INSUFFICIENT_STOCK / ITEM_ARCHIVED (or succeeds if a restock raced in)
    else {
      if (!roleHas(actor.role, 'tx:override')) throw new ForbiddenError('Only supervisors and admins can authorize a checkout beyond recorded stock');
      // PRD §13.3 override vs §38 "never negative": stock is never driven below zero. The shortfall is first written to the ledger
      // as an explicit, attributable "unrecorded movement" adjustment, THEN the checkout draws it down — the discrepancy stays visible.
      const [locked] = await tx.select({ q: items.quantityAvailable }).from(items).where(eq(items.id, item.id)).for('update');
      const have = locked?.q ?? 0;
      const shortfall = Math.max(0, q - have);
      if (shortfall > 0) {
        const up = await applyStockDelta(tx, actor, item.id, shortfall);
        if (!up) throw new ConflictError('ITEM_ARCHIVED', 'This item was archived');
        out.push(await rec(tx, ctx, {
          type: 'adjustment', itemId: item.id, locationId, quantity: shortfall, stockDelta: shortfall, balanceBefore: up.before, balanceAfter: up.after,
          reason: 'unrecorded_movement', note: `Auto-recorded: checkout of ${q} exceeded recorded stock of ${have} (override authorized)`, overrideAuthorizedBy: actor.id,
        }, 'adj'));
        overrideAuthorizedBy = actor.id;
      }
    }
    change = await applyStockDelta(tx, actor, item.id, -q);
    if (!change) throw new ConflictError('INSUFFICIENT_STOCK', 'Stock changed concurrently; please retry');
  }
  out.push(await rec(tx, ctx, { ...common, type: 'checkout', quantity: q, stockDelta: -q, custodyDelta: q, balanceBefore: change.before, balanceAfter: change.after, overrideAuthorizedBy, dueAt: consumableDue }, suffix));
  return out;
}

export interface BatchCheckoutInput {
  holderId: string; lines: Array<{ itemId: string; quantity?: number }>; jobId?: string; locationId?: string; purpose?: string; note?: string; dueAt?: string; snapshotFileId?: string;
}

export async function batchRun(tx: Db, ctx: CoreCtx, input: BatchCheckoutInput): Promise<TxRow[]> {
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new UnprocessableError('DUPLICATE_LINE', 'Each item may appear only once per batch');
  // Process in itemId order so two concurrent batches over overlapping items always take row locks in the same order (no deadlock).
  const order = input.lines.map((l, i) => ({ l, i })).sort((a, b) => (a.l.itemId < b.l.itemId ? -1 : 1));
  const byIndex = new Map<number, TxRow[]>();
  for (const { l, i } of order) {
    try {
      byIndex.set(i, await checkoutRun(tx, ctx, { holderId: input.holderId, itemId: l.itemId, quantity: l.quantity, jobId: input.jobId, locationId: input.locationId, purpose: input.purpose, note: input.note, dueAt: input.dueAt, snapshotFileId: input.snapshotFileId }, String(i)));
    } catch (err) {
      if (err instanceof AppError) throw new AppError(err.statusCode, err.code, `Line ${i + 1}: ${err.message}`, { ...(typeof err.details === 'object' && err.details ? err.details : {}), lineIndex: i, itemId: l.itemId });
      throw err;
    }
  }
  return input.lines.flatMap((_, i) => byIndex.get(i)!); // request order; the whole batch is one atomic DB transaction
}

export function checkout(db: Db, actor: Actor, key: string, input: CheckoutInput, meta?: OpMeta): Promise<OpResult> {
  return execute(db, actor, {
    metricType: 'checkout', key, fingerprint: fingerprintOf('checkout', input), meta,
    gate: { operation: 'checkout', itemId: input.itemId, payload: { input }, required: (tx) => approvalRequired(tx, actor, 'checkout'), precheck: async (tx) => { await validate(tx, actor, input); } },
    run: (tx, ctx) => checkoutRun(tx, ctx, input),
  });
}

export function checkoutBatch(db: Db, actor: Actor, key: string, input: BatchCheckoutInput, meta?: OpMeta): Promise<OpResult> {
  return execute(db, actor, {
    metricType: 'checkout', key, fingerprint: fingerprintOf('checkout_batch', input), meta,
    gate: {
      operation: 'checkout_batch', itemId: null, payload: { input }, required: (tx) => approvalRequired(tx, actor, 'checkout'),
      precheck: async (tx) => { for (const l of input.lines) await validate(tx, actor, { ...input, itemId: l.itemId, quantity: l.quantity }); },
    },
    run: (tx, ctx) => batchRun(tx, ctx, input),
  });
}
