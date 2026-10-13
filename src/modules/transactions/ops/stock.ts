import type { Db } from '../../../db/index.js';
import type { Actor } from '../../../lib/actor.js';
import { fingerprintOf } from '../../../lib/canonical.js';
import { ConflictError } from '../../../lib/errors.js';
import { assertUsableHolder } from '../../holders/service.js';
import { assertUsableJob } from '../../jobs/service.js';
import {
  applyStockDelta, checkSnapshot, execute, loadItem, rec, requireQuantity, requireType, resolveLocation, stockOrConflict,
  type CoreCtx, type OpMeta, type OpResult,
} from '../engine.js';
import type { TxRow } from '../ledger.js';

export interface ConsumeInput { itemId: string; quantity: number; holderId?: string; jobId?: string; locationId?: string; purpose?: string; note?: string; snapshotFileId?: string }
export interface RestockInput { itemId: string; quantity: number; reference?: string; locationId?: string; note?: string; snapshotFileId?: string }

async function validateConsume(tx: Db, actor: Actor, input: ConsumeInput) {
  const item = await loadItem(tx, actor.orgId, input.itemId);
  requireType(item, 'consumable', 'Consumption applies to consumables; tracked assets are checked out instead');
  requireQuantity(input.quantity);
  if (input.holderId) await assertUsableHolder(tx, actor.orgId, input.holderId);
  if (input.jobId) await assertUsableJob(tx, actor.orgId, input.jobId);
  return item;
}

/** PRD §14 — permanent use. Reduces stock, creates NO custody (nothing to return). */
export async function consumeRun(tx: Db, ctx: CoreCtx, input: ConsumeInput, suffix?: string): Promise<TxRow[]> {
  const item = await validateConsume(tx, ctx.actor, input);
  const locationId = await resolveLocation(tx, ctx.actor.orgId, item.locationId, input.locationId);
  const snapshotFileId = await checkSnapshot(tx, ctx, 'consume', input.snapshotFileId);
  const change = await stockOrConflict(tx, ctx.actor, item, -input.quantity, input.quantity);
  return [await rec(tx, ctx, {
    type: 'consume', itemId: item.id, locationId, quantity: input.quantity, stockDelta: -input.quantity, custodyDelta: 0,
    balanceBefore: change.before, balanceAfter: change.after, holderId: input.holderId ?? null, jobId: input.jobId ?? null,
    purpose: input.purpose ?? null, note: input.note ?? null, snapshotFileId,
  }, suffix)];
}

export async function restockRun(tx: Db, ctx: CoreCtx, input: RestockInput, suffix?: string): Promise<TxRow[]> {
  const item = await loadItem(tx, ctx.actor.orgId, input.itemId);
  requireType(item, 'consumable', 'Restocking applies to consumables');
  requireQuantity(input.quantity);
  const locationId = await resolveLocation(tx, ctx.actor.orgId, item.locationId, input.locationId);
  const snapshotFileId = await checkSnapshot(tx, ctx, 'restock', input.snapshotFileId);
  const change = await applyStockDelta(tx, ctx.actor, item.id, input.quantity);
  if (!change) throw new ConflictError('ITEM_ARCHIVED', 'This item was archived');
  return [await rec(tx, ctx, {
    type: 'restock', itemId: item.id, locationId, quantity: input.quantity, stockDelta: input.quantity, custodyDelta: 0,
    balanceBefore: change.before, balanceAfter: change.after, note: input.note ?? null, snapshotFileId,
    metadata: input.reference ? { reference: input.reference } : null,
  }, suffix)];
}

export const consume = (db: Db, actor: Actor, key: string, input: ConsumeInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, { metricType: 'consume', key, fingerprint: fingerprintOf('consume', input), meta, run: (tx, ctx) => consumeRun(tx, ctx, input) });

export const restock = (db: Db, actor: Actor, key: string, input: RestockInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, { metricType: 'restock', key, fingerprint: fingerprintOf('restock', input), meta, run: (tx, ctx) => restockRun(tx, ctx, input) });
