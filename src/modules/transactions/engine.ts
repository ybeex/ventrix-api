/**
 * The transaction engine: shared machinery for every ledger operation.
 *
 *  execute()          one wrapper for all operations: key-scoped lock → replay (with fingerprint check) →
 *                     approval gate (defer) → run the core in the SAME DB transaction → metrics.
 *  applyStockDelta()  the ONLY way stock changes: one conditional UPDATE that cannot go below zero.
 *  transitionAsset()  the ONLY way an asset's state changes: a compare-and-set on its current state.
 *  custody helpers    serialise and measure a holder's outstanding balance for a consumable.
 *
 * Why conditional UPDATEs, not "SELECT, check, UPDATE": two concurrent checkouts of the last 5 units
 * both see 5 under SELECT-then-UPDATE and both succeed. `UPDATE … WHERE qty + delta >= 0` is decided
 * by the row lock inside Postgres, so exactly one wins and the loser sees zero rows — no explicit locks,
 * no retry loops, no oversell (and the DB CHECK constraint would still refuse a negative balance).
 */
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, items, locations, transactions } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { metrics } from '../../lib/metrics.js';
import { likeEscape } from '../../lib/sql.js';
import { createPending, findPendingByKey, type ApprovalOperation, type ApprovalRow } from '../approvals/store.js';
import { getSettings, type OrgSettings } from '../organization/settings.service.js';
import { assertFile } from '../files/service.js';
import { assertSameRequest, countReplay, findByKey, lockKey } from './idempotency.js';
import { recordTx, type NewLedgerRow, type TxRow } from './ledger.js';

export type ItemRow = typeof items.$inferSelect;
export type AssetState = NonNullable<ItemRow['assetState']>;
export type Condition = NonNullable<ItemRow['condition']>;

export interface OpMeta { source?: 'online' | 'sync'; occurredAt?: Date; deviceId?: string | null }

/** Everything a core needs besides its own input. `actor` is the person the ledger will name (the requester, for approved operations). */
export interface CoreCtx {
  actor: Actor;
  key: string;
  fingerprint: string;
  source: 'online' | 'sync';
  occurredAt: Date;
  deviceId: string | null;
  approval?: { id: string; by: string };
  settings: OrgSettings;
  link?: { correctsTransactionId?: string; relatedTransactionId?: string };
}

export type OpResult =
  | { status: 'committed'; rows: TxRow[]; primary: TxRow; replayed: boolean }
  | { status: 'pending_approval'; approval: ApprovalRow; replayed: boolean };

export interface OpSpec {
  metricType: string;
  key: string;
  fingerprint: string;
  meta?: OpMeta;
  gate?: {
    operation: ApprovalOperation;
    itemId: string | null;
    payload: unknown;
    required: (tx: Db) => Promise<boolean>;
    /** Cheap validation so a requester learns about a bad request now, not when a supervisor approves it. */
    precheck: (tx: Db) => Promise<void>;
  };
  run: (tx: Db, ctx: CoreCtx) => Promise<TxRow[]>;
}

const MAX_SKEW_MS = 5 * 60_000;
/** Device clocks lie. The device-claimed time is informational: it may not be in the future, nor absurdly old. */
export function clampOccurredAt(claimed: Date | undefined, now = new Date()): Date {
  if (!claimed) return now;
  const t = claimed.getTime();
  if (t > now.getTime() + MAX_SKEW_MS) return now;
  if (t < now.getTime() - 30 * 86_400_000) return now;
  return new Date(Math.min(t, now.getTime()));
}

export function makeCtx(actor: Actor, spec: Pick<OpSpec, 'key' | 'fingerprint' | 'meta'>, settings: OrgSettings): CoreCtx {
  return {
    actor, key: spec.key, fingerprint: spec.fingerprint, source: spec.meta?.source ?? 'online',
    occurredAt: clampOccurredAt(spec.meta?.occurredAt), deviceId: spec.meta?.deviceId ?? actor.deviceId ?? null, settings,
  };
}

/** Record a ledger row with the per-request fields every row carries. `suffix` gives sibling rows of one request their own unique key. */
export async function rec(tx: Db, ctx: CoreCtx, row: Omit<NewLedgerRow, 'idempotencyKey' | 'requestFingerprint' | 'occurredAt' | 'source' | 'deviceId' | 'approvalId' | 'approvedBy'>, suffix?: string): Promise<TxRow> {
  return recordTx(tx, ctx.actor, {
    ...row,
    correctsTransactionId: row.correctsTransactionId ?? ctx.link?.correctsTransactionId ?? null,
    relatedTransactionId: row.relatedTransactionId ?? ctx.link?.relatedTransactionId ?? null,
    idempotencyKey: suffix === undefined ? ctx.key : `${ctx.key}#${suffix}`,
    requestFingerprint: ctx.fingerprint, occurredAt: ctx.occurredAt, source: ctx.source, deviceId: ctx.deviceId,
    approvalId: ctx.approval?.id ?? null, approvedBy: ctx.approval?.by ?? null,
  });
}

async function priorRows(tx: Db, actor: Actor, key: string): Promise<TxRow[]> {
  return tx.select().from(transactions).where(and(
    eq(transactions.orgId, actor.orgId), eq(transactions.actorUserId, actor.id),
    sql`(${transactions.idempotencyKey} = ${key} or ${transactions.idempotencyKey} like ${likeEscape(key) + '#%'})`,
  )).orderBy(transactions.seq).then((rows) => {
    // Batch lines are keyed `<key>#<requestIndex>`: replays must come back in REQUEST order, exactly as the original response did.
    const idx = (r: TxRow) => /#(\d+)$/.exec(r.idempotencyKey ?? '')?.[1];
    return rows.every((r) => idx(r) !== undefined) ? [...rows].sort((a, b) => Number(idx(a)) - Number(idx(b))) : rows;
  });
}

export async function execute(db: Db, actor: Actor, spec: OpSpec): Promise<OpResult> {
  const settings = await getSettings(db, actor.orgId);
  try {
    const result = await db.transaction(async (tx): Promise<OpResult> => {
      await lockKey(tx, actor.orgId, actor.id, spec.key);

      const rows = await priorRows(tx, actor, spec.key);
      if (rows.length) {
        assertSameRequest(rows[0].requestFingerprint, spec.fingerprint);
        countReplay(spec.metricType);
        return { status: 'committed', rows, primary: rows.find((r) => r.idempotencyKey === spec.key) ?? rows[0], replayed: true };
      }
      const pending = await findPendingByKey(tx, actor.orgId, actor.id, spec.key);
      if (pending) {
        assertSameRequest(pending.requestFingerprint, spec.fingerprint);
        countReplay(spec.metricType);
        return { status: 'pending_approval', approval: pending, replayed: true };
      }

      if (spec.gate && (await spec.gate.required(tx))) {
        await spec.gate.precheck(tx);
        const approval = await createPending(tx, actor, { operation: spec.gate.operation, itemId: spec.gate.itemId, payload: spec.gate.payload, key: spec.key, fingerprint: spec.fingerprint });
        return { status: 'pending_approval', approval, replayed: false };
      }

      const out = await spec.run(tx, makeCtx(actor, spec, settings));
      return { status: 'committed', rows: out, primary: out.find((r) => r.idempotencyKey === spec.key) ?? out[0], replayed: false };
    });
    if (!result.replayed) metrics.transactions.inc({ type: spec.metricType, outcome: result.status === 'committed' ? 'committed' : 'deferred' });
    return result;
  } catch (err) {
    if (err instanceof AppError) metrics.transactions.inc({ type: spec.metricType, outcome: err.statusCode === 409 ? 'conflict' : 'rejected' });
    throw err;
  }
}

// ── Item loading & validation ───────────────────────────────────────

export async function loadItem(tx: Db, orgId: string, id: string, opts: { allowArchived?: boolean } = {}): Promise<ItemRow> {
  const [item] = await tx.select().from(items).where(and(eq(items.id, id), eq(items.orgId, orgId))).limit(1);
  if (!item) throw new NotFoundError('Item');
  if (item.archivedAt && !opts.allowArchived) throw new ConflictError('ITEM_ARCHIVED', 'Archived items cannot take part in transactions; restore the item first');
  return item;
}

export function requireType(item: ItemRow, type: 'asset' | 'consumable', hint: string): void {
  if (item.type !== type) throw new UnprocessableError('NOT_APPLICABLE', hint);
}

export function requireQuantity(q: number | undefined): number {
  if (q === undefined || !Number.isInteger(q) || q < 1) throw new UnprocessableError('QUANTITY_REQUIRED', 'A whole-number quantity of at least 1 is required for consumables');
  return q;
}

/** PRD §23: photos are optional unless the org's policy requires one for this operation. */
export async function checkSnapshot(tx: Db, ctx: Pick<CoreCtx, 'actor' | 'settings'>, op: string, fileId?: string | null): Promise<string | null> {
  if (!fileId) {
    if (ctx.settings.requirePhotoFor.includes(op)) throw new UnprocessableError('PHOTO_REQUIRED', `Your organization requires a photo for this operation (${op})`);
    return null;
  }
  await assertFile(tx, ctx.actor.orgId, fileId, 'transaction_snapshot');
  return fileId;
}

// ── Stock ───────────────────────────────────────────────────────────

const effectiveMinSql = sql<number | null>`coalesce(${items.minQuantity}, (select ${categories.defaultMinQuantity} from ${categories} where ${categories.id} = ${items.categoryId}))`;

export interface StockChange { before: number; after: number }

/**
 * Atomically adds `delta` (±) to an item's quantity, refusing to go below zero. Returns null when the guard
 * rejected it (insufficient stock, or the item is archived/missing) — the caller decides which error that is.
 * Emits a `stock.low` event the instant the balance crosses down through its minimum.
 */
export async function applyStockDelta(tx: Db, actor: Actor, itemId: string, delta: number): Promise<StockChange | null> {
  const [row] = await tx.update(items).set({ quantityAvailable: sql`${items.quantityAvailable} + ${delta}`, updatedAt: new Date(), updatedBy: actor.id })
    .where(and(eq(items.id, itemId), eq(items.orgId, actor.orgId), isNull(items.archivedAt), eq(items.type, 'consumable'), sql`${items.quantityAvailable} + ${delta} >= 0`))
    .returning({ after: items.quantityAvailable, min: effectiveMinSql });
  if (!row) return null;
  const after = row.after!;
  const before = after - delta;
  if (row.min !== null && before > row.min && after <= row.min) {
    await emitEvent(tx, actor.orgId, { type: 'stock.low', itemId, balance: after, minimum: row.min });
  }
  return { before, after };
}

export async function stockOrConflict(tx: Db, actor: Actor, item: ItemRow, delta: number, requested: number): Promise<StockChange> {
  const change = await applyStockDelta(tx, actor, item.id, delta);
  if (change) return change;
  const [cur] = await tx.select({ q: items.quantityAvailable, archived: items.archivedAt }).from(items).where(eq(items.id, item.id)).limit(1);
  if (cur?.archived) throw new ConflictError('ITEM_ARCHIVED', 'This item was archived');
  throw new ConflictError('INSUFFICIENT_STOCK', `Only ${cur?.q ?? 0} available; ${requested} requested`, { available: cur?.q ?? 0, requested });
}

// ── Asset state ─────────────────────────────────────────────────────

export interface AssetPatch {
  holderId?: string | null; jobId?: string | null; checkedOutAt?: Date | null; dueAt?: Date | null; condition?: Condition;
}

/** Compare-and-set the asset's state. Returns null when the item wasn't in an allowed `from` state (someone else got there first). */
export async function transitionAsset(
  tx: Db, actor: Actor, itemId: string, from: AssetState[], to: AssetState, patch: AssetPatch, expectHolderId?: string | null,
): Promise<ItemRow | null> {
  const leaving = to !== 'checked_out';
  const [row] = await tx.update(items).set({
    assetState: to,
    currentHolderId: patch.holderId !== undefined ? patch.holderId : leaving ? null : undefined,
    currentJobId: patch.jobId !== undefined ? patch.jobId : leaving ? null : undefined,
    checkedOutAt: patch.checkedOutAt !== undefined ? patch.checkedOutAt : leaving ? null : undefined,
    dueAt: patch.dueAt !== undefined ? patch.dueAt : leaving ? null : undefined,
    ...(patch.condition ? { condition: patch.condition } : {}),
    updatedAt: new Date(), updatedBy: actor.id,
  }).where(and(
    eq(items.id, itemId), eq(items.orgId, actor.orgId), isNull(items.archivedAt), eq(items.type, 'asset'), inArray(items.assetState, from),
    expectHolderId ? eq(items.currentHolderId, expectHolderId) : undefined,
  )).returning();
  return row ?? null;
}

export const wrongState = (item: ItemRow, expected: string) =>
  new ConflictError('INVALID_STATE', `This asset is ${item.assetState}; ${expected}`, { state: item.assetState, holderId: item.currentHolderId });

// ── Custody (consumable balances held by a holder) ──────────────────

/** Serialise concurrent returns/corrections for one (item, holder) so outstanding can be checked then reduced safely. */
export async function lockCustody(tx: Db, itemId: string, holderId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`custody:${itemId}:${holderId}`}, 0))`);
}

export async function outstandingFor(tx: Db, orgId: string, itemId: string, holderId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${transactions.custodyDelta}), 0)::int` }).from(transactions)
    .where(and(eq(transactions.orgId, orgId), eq(transactions.itemId, itemId), eq(transactions.holderId, holderId)));
  return r.n;
}

export async function categoryDefaultReturnHours(tx: Db, categoryId: string | null): Promise<number | null> {
  if (!categoryId) return null;
  const [c] = await tx.select({ h: categories.defaultExpectedReturnHours }).from(categories).where(eq(categories.id, categoryId)).limit(1);
  return c?.h ?? null;
}

void like;

export async function resolveLocation(tx: Db, orgId: string, itemLocationId: string, requested?: string): Promise<string> {
  if (!requested || requested === itemLocationId) return itemLocationId;
  const [loc] = await tx.select({ id: locations.id, archivedAt: locations.archivedAt }).from(locations).where(and(eq(locations.id, requested), eq(locations.orgId, orgId))).limit(1);
  if (!loc || loc.archivedAt) throw new UnprocessableError('LOCATION_NOT_FOUND', 'Location not found or archived');
  return loc.id;
}
