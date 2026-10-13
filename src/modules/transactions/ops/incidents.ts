/**
 * Adjustments, loss, damage and condition/state updates (PRD §17, §18, §12, §32).
 * Loss and damage are first-class events — never a disguised negative adjustment — and they work for
 * tracked assets (a drill goes missing on site) as well as consumables. Every way OUT of a bad state
 * (found a lost drill, repaired a damaged one, retired a dead one) is a recorded CONDITION_UPDATE.
 */
import type { Db } from '../../../db/index.js';
import type { Actor } from '../../../lib/actor.js';
import { fingerprintOf } from '../../../lib/canonical.js';
import { ConflictError, UnprocessableError } from '../../../lib/errors.js';
import { assertUsableHolder } from '../../holders/service.js';
import { assertUsableJob } from '../../jobs/service.js';
import {
  checkSnapshot, execute, loadItem, rec, requireQuantity, requireType, resolveLocation, stockOrConflict, transitionAsset,
  type AssetState, type Condition, type CoreCtx, type ItemRow, type OpMeta, type OpResult,
} from '../engine.js';
import type { TxRow } from '../ledger.js';
import { approvalRequired } from '../policy.js';

type Reason = 'count_correction' | 'opening_balance_correction' | 'unrecorded_movement' | 'damage' | 'loss' | 'other';

// ── Adjustment (consumables; PRD §18) ───────────────────────────────

export interface AdjustInput { itemId: string; quantityDelta: number; reason: Reason; note?: string; locationId?: string; snapshotFileId?: string }

async function validateAdjust(tx: Db, actor: Actor, input: AdjustInput) {
  const item = await loadItem(tx, actor.orgId, input.itemId);
  requireType(item, 'consumable', 'Stock adjustments apply to consumables; use loss, damage or a condition update for tracked assets');
  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) throw new UnprocessableError('INVALID_DELTA', 'The adjustment must be a non-zero whole number');
  if (input.reason === 'other' && !input.note?.trim()) throw new UnprocessableError('NOTE_REQUIRED', 'Explain the adjustment when the reason is "other"');
  return item;
}

export async function adjustRun(tx: Db, ctx: CoreCtx, input: AdjustInput, suffix?: string): Promise<TxRow[]> {
  const item = await validateAdjust(tx, ctx.actor, input);
  const locationId = await resolveLocation(tx, ctx.actor.orgId, item.locationId, input.locationId);
  const snapshotFileId = await checkSnapshot(tx, ctx, 'adjustment', input.snapshotFileId);
  const change = await stockOrConflict(tx, ctx.actor, item, input.quantityDelta, Math.abs(input.quantityDelta));
  return [await rec(tx, ctx, {
    type: 'adjustment', itemId: item.id, locationId, quantity: Math.abs(input.quantityDelta), stockDelta: input.quantityDelta, custodyDelta: 0,
    balanceBefore: change.before, balanceAfter: change.after, reason: input.reason, note: input.note ?? null, snapshotFileId,
  }, suffix)];
}

export const adjust = (db: Db, actor: Actor, key: string, input: AdjustInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, {
    metricType: 'adjustment', key, fingerprint: fingerprintOf('adjustment', input), meta,
    gate: { operation: 'adjustment', itemId: input.itemId, payload: { input }, required: (tx) => approvalRequired(tx, actor, 'adjustment', Math.abs(input.quantityDelta)), precheck: async (tx) => { await validateAdjust(tx, actor, input); } },
    run: (tx, ctx) => adjustRun(tx, ctx, input),
  });

// ── Loss & damage (PRD §17) ─────────────────────────────────────────

export interface IncidentInput { itemId: string; note: string; quantity?: number; holderId?: string; jobId?: string; locationId?: string; snapshotFileId?: string }

const LOSS_FROM: AssetState[] = ['available', 'checked_out', 'damaged', 'under_repair'];
const DAMAGE_FROM: AssetState[] = ['available', 'checked_out', 'under_repair'];

async function validateIncident(tx: Db, actor: Actor, input: IncidentInput): Promise<ItemRow> {
  const item = await loadItem(tx, actor.orgId, input.itemId);
  if (!input.note?.trim()) throw new UnprocessableError('NOTE_REQUIRED', 'Describe what happened');
  if (item.type === 'consumable') requireQuantity(input.quantity);
  else if (input.quantity !== undefined && input.quantity !== 1) throw new UnprocessableError('NOT_APPLICABLE', 'A tracked asset is a single unit');
  if (input.holderId) await assertUsableHolder(tx, actor.orgId, input.holderId);
  if (input.jobId) await assertUsableJob(tx, actor.orgId, input.jobId);
  return item;
}

async function incidentRun(tx: Db, ctx: CoreCtx, input: IncidentInput, kind: 'loss' | 'damage', suffix?: string): Promise<TxRow[]> {
  const { actor } = ctx;
  const item = await validateIncident(tx, actor, input);
  const locationId = await resolveLocation(tx, actor.orgId, item.locationId, input.locationId);
  const snapshotFileId = await checkSnapshot(tx, ctx, kind, input.snapshotFileId);
  const base = { type: kind, itemId: item.id, locationId, note: input.note, snapshotFileId, reason: kind as Reason } as const;

  if (item.type === 'consumable') {
    const q = requireQuantity(input.quantity);
    const change = await stockOrConflict(tx, actor, item, -q, q);
    return [await rec(tx, ctx, { ...base, quantity: q, stockDelta: -q, custodyDelta: 0, balanceBefore: change.before, balanceAfter: change.after, holderId: input.holderId ?? null, jobId: input.jobId ?? null }, suffix)];
  }

  const to: AssetState = kind === 'loss' ? 'lost' : 'damaged';
  const wasHeld = item.assetState === 'checked_out';
  const updated = await transitionAsset(tx, actor, item.id, kind === 'loss' ? LOSS_FROM : DAMAGE_FROM, to, kind === 'damage' ? { condition: 'damaged' } : {}, wasHeld ? item.currentHolderId : undefined);
  if (!updated) throw new ConflictError('INVALID_STATE', `This asset is ${item.assetState}; it cannot be reported ${kind === 'loss' ? 'lost' : 'damaged'} from that state`, { state: item.assetState });
  // If it was out on site, the holder stays on the record (accountability) and their custody ends: it is no longer "checked out".
  return [await rec(tx, ctx, {
    ...base, quantity: 1, stockDelta: 0, custodyDelta: wasHeld ? -1 : 0, stateBefore: item.assetState, stateAfter: to,
    holderId: wasHeld ? item.currentHolderId : (input.holderId ?? null), jobId: wasHeld ? item.currentJobId : (input.jobId ?? null),
    condition: kind === 'damage' ? 'damaged' : item.condition,
  }, suffix)];
}

export const lossRun = (tx: Db, ctx: CoreCtx, input: IncidentInput, suffix?: string) => incidentRun(tx, ctx, input, 'loss', suffix);
export const damageRun = (tx: Db, ctx: CoreCtx, input: IncidentInput, suffix?: string) => incidentRun(tx, ctx, input, 'damage', suffix);

export const reportLoss = (db: Db, actor: Actor, key: string, input: IncidentInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, {
    metricType: 'loss', key, fingerprint: fingerprintOf('loss', input), meta,
    gate: { operation: 'loss', itemId: input.itemId, payload: { input }, required: (tx) => approvalRequired(tx, actor, 'loss'), precheck: async (tx) => { await validateIncident(tx, actor, input); } },
    run: (tx, ctx) => lossRun(tx, ctx, input),
  });

export const reportDamage = (db: Db, actor: Actor, key: string, input: IncidentInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, { metricType: 'damage', key, fingerprint: fingerprintOf('damage', input), meta, run: (tx, ctx) => damageRun(tx, ctx, input) });

// ── Condition / state update (PRD §12, §15.2) ───────────────────────

export interface ConditionInput { itemId: string; toState?: Exclude<AssetState, 'checked_out' | 'lost'>; condition?: Condition; note: string; snapshotFileId?: string }

const ALLOWED: Record<AssetState, AssetState[]> = {
  available: ['under_repair', 'damaged', 'retired'],
  damaged: ['available', 'under_repair', 'retired'],
  under_repair: ['available', 'damaged', 'retired'],
  lost: ['available', 'retired'], // found again, or written off
  checked_out: [], // must be checked in first
  retired: [], // terminal
};
const DEFAULT_CONDITION: Record<AssetState, Condition> = { available: 'good', under_repair: 'needs_inspection', damaged: 'damaged', retired: 'replaced', lost: 'good', checked_out: 'good' };

async function validateCondition(tx: Db, actor: Actor, input: ConditionInput) {
  const item = await loadItem(tx, actor.orgId, input.itemId);
  requireType(item, 'asset', 'Condition and state apply to tracked assets');
  if (!input.note?.trim()) throw new UnprocessableError('NOTE_REQUIRED', 'Say why the condition or state is changing');
  if (!input.toState && !input.condition) throw new UnprocessableError('NOTHING_TO_CHANGE', 'Provide a new state and/or condition');
  const from = item.assetState!;
  if (from === 'checked_out') throw new ConflictError('ITEM_CHECKED_OUT', 'Check this asset in before changing its state');
  if (from === 'retired') throw new ConflictError('INVALID_STATE', 'A retired asset cannot change state');
  if (input.toState && input.toState !== from && !ALLOWED[from].includes(input.toState)) {
    throw new ConflictError('INVALID_TRANSITION', `An asset that is ${from} cannot become ${input.toState}`, { from, allowed: ALLOWED[from] });
  }
  return item;
}

export async function conditionRun(tx: Db, ctx: CoreCtx, input: ConditionInput, suffix?: string): Promise<TxRow[]> {
  const { actor } = ctx;
  const item = await validateCondition(tx, actor, input);
  const from = item.assetState!;
  const to = input.toState ?? from;
  const condition = input.condition ?? (input.toState ? DEFAULT_CONDITION[to] : item.condition ?? 'good');
  const snapshotFileId = await checkSnapshot(tx, ctx, 'condition', input.snapshotFileId);
  const updated = await transitionAsset(tx, actor, item.id, [from], to, { condition });
  if (!updated) throw new ConflictError('INVALID_STATE', 'This asset changed state concurrently; reload and retry');
  return [await rec(tx, ctx, {
    type: 'condition_update', itemId: item.id, locationId: item.locationId, quantity: 1, stockDelta: 0, custodyDelta: 0,
    stateBefore: from, stateAfter: to, condition, note: input.note, snapshotFileId,
  }, suffix)];
}

export const updateCondition = (db: Db, actor: Actor, key: string, input: ConditionInput, meta?: OpMeta): Promise<OpResult> =>
  execute(db, actor, {
    metricType: 'condition_update', key, fingerprint: fingerprintOf('condition', input), meta,
    // Retirement is the approval-gated step (PRD §32); every other state change is direct.
    gate: { operation: 'retirement', itemId: input.itemId, payload: { input }, required: async (tx) => input.toState === 'retired' && approvalRequired(tx, actor, 'retirement'), precheck: async (tx) => { await validateCondition(tx, actor, input); } },
    run: (tx, ctx) => conditionRun(tx, ctx, input),
  });
