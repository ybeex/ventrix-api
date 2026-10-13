/**
 * Corrections (PRD §24, §36.2, §50): history is never edited. A mistake is fixed by appending a REVERSAL row
 * (CORRECTION type, linked to the original) that exactly negates the original's stock/custody/state effect,
 * optionally followed by a REPLACEMENT row (a normal operation, also linked) carrying the right values.
 * Because every row is a signed delta, "stock = sum of deltas" holds before and after.
 *
 * A correction is refused (409 CORRECTION_BLOCKED) when later activity depends on the original — e.g. you
 * cannot undo a checkout that has since been returned, or a stock addition that has since been consumed.
 * The fix is then to record the compensating operation instead. Limited to one reversal per transaction
 * (unique index) and to admins.
 */
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../../../db/index.js';
import { transactions } from '../../../db/schema.js';
import type { Actor } from '../../../lib/actor.js';
import { fingerprintOf } from '../../../lib/canonical.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../../lib/errors.js';
import {
  applyStockDelta, execute, loadItem, lockCustody, outstandingFor, rec, transitionAsset,
  type AssetPatch, type Condition, type CoreCtx, type OpMeta, type OpResult,
} from '../engine.js';
import type { TxRow } from '../ledger.js';
import { checkinRun, type CheckinInput } from './checkin.js';
import { checkoutRun, type CheckoutInput } from './checkout.js';
import { adjustRun, conditionRun, damageRun, lossRun, type AdjustInput, type ConditionInput, type IncidentInput } from './incidents.js';
import { consumeRun, restockRun, type ConsumeInput, type RestockInput } from './stock.js';

export interface CorrectionInput { transactionId: string; note: string; replacement?: Record<string, unknown> }

const CORRECTABLE = ['checkout', 'checkin', 'consume', 'restock', 'adjustment', 'loss', 'damage', 'condition_update'];
const STATE_CHANGING = ['checkout', 'checkin', 'loss', 'damage', 'condition_update', 'correction'];

/** Which fields a replacement may override, per original type — anything else is a client error. */
const REPLACEABLE: Record<string, string[]> = {
  checkout: ['itemId', 'holderId', 'quantity', 'jobId', 'purpose', 'dueAt'],
  checkin: ['itemId', 'holderId', 'quantity', 'condition'],
  consume: ['itemId', 'quantity', 'holderId', 'jobId', 'purpose'],
  restock: ['itemId', 'quantity'],
  adjustment: ['itemId', 'quantityDelta', 'reason'],
  loss: ['itemId', 'quantity', 'holderId'],
  damage: ['itemId', 'quantity', 'holderId'],
  condition_update: ['toState', 'condition'],
};

const blocked = (message: string, details?: unknown) => new ConflictError('CORRECTION_BLOCKED', message, details);

async function priorCondition(tx: Db, itemId: string, beforeSeq: number): Promise<Condition> {
  const [r] = await tx.select({ c: transactions.condition }).from(transactions)
    .where(and(eq(transactions.itemId, itemId), lt(transactions.seq, beforeSeq), sql`${transactions.condition} is not null`)).orderBy(desc(transactions.seq)).limit(1);
  return r?.c ?? 'good';
}

export async function correctRun(tx: Db, ctx: CoreCtx, input: CorrectionInput): Promise<TxRow[]> {
  const { actor } = ctx;
  const [orig] = await tx.select().from(transactions).where(and(eq(transactions.id, input.transactionId), eq(transactions.orgId, actor.orgId))).limit(1);
  if (!orig) throw new NotFoundError('Transaction');
  if (!CORRECTABLE.includes(orig.type)) throw new ConflictError('NOT_CORRECTABLE', `A ${orig.type} entry cannot be corrected; use the matching operation instead`);
  const [done] = await tx.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.correctsTransactionId, orig.id), eq(transactions.type, 'correction'))).limit(1);
  if (done) throw new ConflictError('ALREADY_CORRECTED', 'This transaction has already been corrected', { correctionId: done.id });

  const item = await loadItem(tx, actor.orgId, orig.itemId);
  const note = input.note.trim();
  let reversal: TxRow;

  if (item.type === 'consumable') {
    const stockRev = -orig.stockDelta;
    const custodyRev = -orig.custodyDelta;
    if (custodyRev !== 0 && orig.holderId) {
      await lockCustody(tx, item.id, orig.holderId);
      const out = await outstandingFor(tx, actor.orgId, item.id, orig.holderId);
      if (out + custodyRev < 0) throw blocked('That holder has already returned (some of) these items, so the issue cannot be undone; record the correct return instead', { outstanding: out });
    }
    let before = item.quantityAvailable!;
    let after = before;
    if (stockRev !== 0) {
      const c = await applyStockDelta(tx, actor, item.id, stockRev);
      if (!c) throw blocked('Reversing this would take stock below zero (the units have since been used); record a loss or adjustment instead', { available: item.quantityAvailable });
      before = c.before; after = c.after;
    }
    reversal = await rec(tx, ctx, {
      type: 'correction', itemId: item.id, locationId: orig.locationId, quantity: orig.quantity, stockDelta: stockRev, custodyDelta: custodyRev,
      balanceBefore: before, balanceAfter: after, holderId: orig.holderId, jobId: orig.jobId, reason: orig.reason, note,
      correctsTransactionId: orig.id,
    });
  } else {
    const [later] = await tx.select({ id: transactions.id }).from(transactions)
      .where(and(eq(transactions.itemId, item.id), gt(transactions.seq, orig.seq), inArray(transactions.type, STATE_CHANGING as never[]))).orderBy(asc(transactions.seq)).limit(1);
    if (later) throw blocked('Later activity depends on this entry; only the most recent state change of an asset can be corrected', { laterTransactionId: later.id });
    if (!orig.stateBefore || item.assetState !== orig.stateAfter) throw blocked('The asset is no longer in the state this entry left it in');

    const target = orig.stateBefore;
    const patch: AssetPatch = { condition: await priorCondition(tx, item.id, orig.seq) };
    if (target === 'checked_out') {
      const [lastOut] = await tx.select().from(transactions).where(and(
        eq(transactions.itemId, item.id), eq(transactions.type, 'checkout'), lt(transactions.seq, orig.seq),
        sql`not exists (select 1 from transactions c where c.type = 'correction' and c.corrects_transaction_id = ${transactions.id})`,
      )).orderBy(desc(transactions.seq)).limit(1);
      if (!lastOut) throw blocked('Cannot find the checkout this entry followed');
      patch.holderId = orig.holderId ?? lastOut.holderId; patch.jobId = lastOut.jobId; patch.checkedOutAt = lastOut.occurredAt; patch.dueAt = lastOut.dueAt;
    }
    const updated = await transitionAsset(tx, actor, item.id, [item.assetState!], target, patch);
    if (!updated) throw blocked('The asset changed state concurrently; reload and retry');
    reversal = await rec(tx, ctx, {
      type: 'correction', itemId: item.id, locationId: orig.locationId, quantity: 1, stockDelta: 0, custodyDelta: -orig.custodyDelta,
      stateBefore: item.assetState, stateAfter: target, holderId: orig.holderId, jobId: orig.jobId, condition: patch.condition ?? null, note,
      correctsTransactionId: orig.id,
    });
  }

  const rows = [reversal];
  if (input.replacement) {
    const allowed = REPLACEABLE[orig.type];
    const extra = Object.keys(input.replacement).filter((k) => !allowed.includes(k));
    if (extra.length) throw new UnprocessableError('INVALID_REPLACEMENT', `A replacement for a ${orig.type} may change only: ${allowed.join(', ')}`, { rejected: extra });
    const ctx2: CoreCtx = { ...ctx, link: { correctsTransactionId: orig.id, relatedTransactionId: reversal.id } };
    const r = input.replacement;
    const cons = item.type === 'consumable';
    const why = `Correction of ${orig.id}: ${note}`;
    const merge = <T extends object>(base: T) => ({ ...base, ...r }) as T;
    switch (orig.type) {
      case 'checkout': rows.push(...await checkoutRun(tx, ctx2, merge<CheckoutInput>({ itemId: orig.itemId, holderId: orig.holderId!, quantity: cons ? orig.quantity ?? undefined : undefined, jobId: orig.jobId ?? undefined, purpose: orig.purpose ?? undefined, note: why }), 'rep')); break;
      case 'checkin': rows.push(...await checkinRun(tx, ctx2, merge<CheckinInput>({ itemId: orig.itemId, holderId: orig.holderId ?? undefined, quantity: cons ? orig.quantity ?? undefined : undefined, condition: cons ? undefined : orig.condition ?? undefined, note: why }), 'rep')); break;
      case 'consume': rows.push(...await consumeRun(tx, ctx2, merge<ConsumeInput>({ itemId: orig.itemId, quantity: orig.quantity ?? 0, holderId: orig.holderId ?? undefined, jobId: orig.jobId ?? undefined, purpose: orig.purpose ?? undefined, note: why }), 'rep')); break;
      case 'restock': rows.push(...await restockRun(tx, ctx2, merge<RestockInput>({ itemId: orig.itemId, quantity: orig.quantity ?? 0, note: why }), 'rep')); break;
      case 'adjustment': rows.push(...await adjustRun(tx, ctx2, merge<AdjustInput>({ itemId: orig.itemId, quantityDelta: orig.stockDelta, reason: orig.reason ?? 'other', note: why }), 'rep')); break;
      case 'loss': rows.push(...await lossRun(tx, ctx2, merge<IncidentInput>({ itemId: orig.itemId, quantity: cons ? orig.quantity ?? undefined : undefined, holderId: orig.holderId ?? undefined, note: why }), 'rep')); break;
      case 'damage': rows.push(...await damageRun(tx, ctx2, merge<IncidentInput>({ itemId: orig.itemId, quantity: cons ? orig.quantity ?? undefined : undefined, holderId: orig.holderId ?? undefined, note: why }), 'rep')); break;
      case 'condition_update': rows.push(...await conditionRun(tx, ctx2, merge<ConditionInput>({ itemId: orig.itemId, toState: (orig.stateAfter as ConditionInput['toState']) ?? undefined, condition: orig.condition ?? undefined, note: why }), 'rep')); break;
    }
  }
  return rows;
}

export const correct = (db: Db, actor: Actor, key: string, input: CorrectionInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, { metricType: 'correction', key, fingerprint: fingerprintOf('correction', input), meta, run: (tx, ctx) => correctRun(tx, ctx, input) });
