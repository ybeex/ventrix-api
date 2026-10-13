import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, items, locations, pendingApprovals, reconciliationCounts, reconciliations, shelves, transactions } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { fingerprintOf } from '../../lib/canonical.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { metrics } from '../../lib/metrics.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { createPending, type ApprovalRow } from '../approvals/store.js';
import { checkSnapshot, execute, rec, type CoreCtx, type OpMeta, type OpResult } from '../engine-exports.js';
import { adjustRun, lossRun, type AdjustInput, type IncidentInput } from '../transactions/ops/incidents.js';
import { approvalRequired } from '../transactions/policy.js';
import type { TxRow } from '../transactions/ledger.js';
import { countsResolved } from './queries.js';

type Scope = 'item' | 'category' | 'shelf' | 'location';
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

export async function startReconciliation(db: Db, actor: Actor, input: { scope: Scope; scopeId: string; note?: string }) {
  return db.transaction(async (tx) => {
    // The scope id is client-supplied: verify it names something in THIS organization (a FK would only prove it exists somewhere).
    const table = input.scope === 'item' ? items : input.scope === 'category' ? categories : input.scope === 'shelf' ? shelves : locations;
    const [target] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, input.scopeId), eq(table.orgId, actor.orgId))).limit(1);
    if (!target) throw new UnprocessableError('SCOPE_NOT_FOUND', `${input.scope} not found`);
    const [row] = await tx.insert(reconciliations).values({ orgId: actor.orgId, scope: input.scope, scopeId: input.scopeId, note: input.note ?? null, startedBy: actor.id }).returning();
    await audit(tx, actor, { action: 'reconciliation.started', entityType: 'reconciliation', entityId: row.id, next: { scope: input.scope, scopeId: input.scopeId } });
    return row;
  });
}

export interface CountInput { itemId: string; physicalQuantity: number; reason?: string; note?: string; snapshotFileId?: string; adjust?: boolean }

async function countRun(tx: Db, ctx: CoreCtx, reconciliationId: string, input: CountInput): Promise<TxRow[]> {
  const { actor, settings } = ctx;
  // FOR SHARE: a concurrent close waits for in-flight counts, and counts that start after the close see it.
  const [session] = await tx.select().from(reconciliations).where(and(eq(reconciliations.id, reconciliationId), eq(reconciliations.orgId, actor.orgId))).for('share');
  if (!session) throw new NotFoundError('Reconciliation');
  if (session.status !== 'open') throw new ConflictError('RECONCILIATION_CLOSED', 'This reconciliation has been closed');

  // Lock the item so the system quantity we snapshot is exactly the one the variance and any adjustment are computed against.
  const [item] = await tx.select().from(items).where(and(eq(items.id, input.itemId), eq(items.orgId, actor.orgId))).for('update');
  if (!item) throw new NotFoundError('Item');
  if (item.archivedAt) throw new ConflictError('ITEM_ARCHIVED', 'Archived items cannot be counted');
  let inScope: boolean;
  if (session.scope === 'item') inScope = item.id === session.scopeId;
  else if (session.scope === 'category') inScope = item.categoryId === session.scopeId;
  else if (session.scope === 'shelf') inScope = (await tx.select({ s: categories.shelfId }).from(categories).where(eq(categories.id, item.categoryId)).limit(1))[0]?.s === session.scopeId;
  else inScope = item.locationId === session.scopeId;
  if (!inScope) throw new UnprocessableError('OUT_OF_SCOPE', `This item is not part of this reconciliation's ${session.scope}`);

  const isAsset = item.type === 'asset';
  if (isAsset && input.physicalQuantity > 1) throw new UnprocessableError('INVALID_QUANTITY', 'A tracked asset is counted as present (1) or missing (0)');
  // Assets are verified by presence: the system expects an AVAILABLE asset to be in the store; anything else is expected to be elsewhere.
  const system = isAsset ? (item.assetState === 'available' ? 1 : 0) : item.quantityAvailable!;
  const variance = input.physicalQuantity - system;
  if (variance !== 0 && settings.reconciliationRequireReason && !input.reason?.trim()) {
    throw new UnprocessableError('REASON_REQUIRED', 'A reason is required when the physical count differs from the system');
  }
  const snapshotFileId = await checkSnapshot(tx, ctx, 'reconciliation', input.snapshotFileId);

  const ledger = await rec(tx, ctx, {
    type: 'reconciliation', itemId: item.id, locationId: item.locationId, quantity: input.physicalQuantity, stockDelta: 0, custodyDelta: 0,
    balanceBefore: isAsset ? null : system, balanceAfter: isAsset ? null : system, stateBefore: item.assetState, stateAfter: item.assetState,
    note: input.reason?.trim() || input.note || null, snapshotFileId,
    metadata: { reconciliationId, systemQuantity: system, physicalQuantity: input.physicalQuantity, variance },
  });
  const out: TxRow[] = [ledger];
  const ctxLinked: CoreCtx = { ...ctx, link: { relatedTransactionId: ledger.id } };

  let adjustmentTx: TxRow | null = null;
  let pending: ApprovalRow | null = null;
  if (input.adjust && variance !== 0) {
    // Resolving a variance is an ordinary adjustment/loss and obeys the SAME approval policy as any other:
    // reconciliation is not a back door for silently erasing discrepancies (PRD §18).
    if (!isAsset) {
      const adj: AdjustInput = { itemId: item.id, quantityDelta: variance, reason: 'count_correction', note: input.reason?.trim() || 'Reconciliation count', snapshotFileId: snapshotFileId ?? undefined };
      if (await approvalRequired(tx, actor, 'adjustment', Math.abs(variance))) {
        pending = await createPending(tx, actor, { operation: 'adjustment', itemId: item.id, payload: { input: adj }, key: `${ctx.key}#adj`, fingerprint: ctx.fingerprint });
      } else {
        [adjustmentTx] = await adjustRun(tx, ctxLinked, adj, 'adj');
        out.push(adjustmentTx);
      }
    } else if (variance === -1 && item.assetState === 'available') {
      const loss: IncidentInput = { itemId: item.id, note: input.reason?.trim() || 'Not found during reconciliation', snapshotFileId: snapshotFileId ?? undefined };
      if (await approvalRequired(tx, actor, 'loss')) {
        pending = await createPending(tx, actor, { operation: 'loss', itemId: item.id, payload: { input: loss }, key: `${ctx.key}#adj`, fingerprint: ctx.fingerprint });
      } else {
        [adjustmentTx] = await lossRun(tx, ctxLinked, loss, 'adj');
        out.push(adjustmentTx);
      }
    } else {
      throw new UnprocessableError('ADJUSTMENT_NOT_APPLICABLE', 'This asset variance cannot be resolved automatically; correct its state with a condition update or check-in');
    }
  }

  // Written once, complete, never updated (trigger-enforced): the original system quantity and variance stay intact forever.
  const [count] = await tx.insert(reconciliationCounts).values({
    reconciliationId, orgId: actor.orgId, itemId: item.id, systemQuantity: system, physicalQuantity: input.physicalQuantity, variance,
    reason: input.reason?.trim() ?? null, note: input.note ?? null, countedBy: actor.id, ledgerTransactionId: ledger.id,
    adjustmentTransactionId: adjustmentTx?.id ?? null, pendingApprovalId: pending?.id ?? null, snapshotFileId, idempotencyKey: ctx.key, requestFingerprint: ctx.fingerprint,
  }).returning();
  await audit(tx, actor, { action: 'reconciliation.count_recorded', entityType: 'reconciliation', entityId: reconciliationId, transactionId: ledger.id, previous: { systemQuantity: system }, next: { physicalQuantity: input.physicalQuantity, variance }, reason: input.reason ?? null });
  metrics.reconciliationCounts.inc();
  if (variance !== 0) {
    metrics.discrepancies.inc();
    await emitEvent(tx, actor.orgId, { type: 'reconciliation.discrepancy', reconciliationId, countId: count.id, itemId: item.id, variance, countedBy: actor.id });
  }
  return out;
}

export function recordCount(db: Db, actor: Actor, reconciliationId: string, key: string, input: CountInput, meta?: OpMeta): Promise<OpResult> {
  return execute(db, actor, { metricType: 'reconciliation', key, fingerprint: fingerprintOf('reconciliation', reconciliationId, input), meta, run: (tx, ctx) => countRun(tx, ctx, reconciliationId, input) });
}

export async function closeReconciliation(db: Db, actor: Actor, id: string, note?: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.update(reconciliations).set({ status: 'closed', closedBy: actor.id, closedAt: new Date(), ...(note ? { note } : {}) })
      .where(and(eq(reconciliations.id, id), eq(reconciliations.orgId, actor.orgId), eq(reconciliations.status, 'open'))).returning();
    if (!row) {
      const [cur] = await tx.select({ id: reconciliations.id }).from(reconciliations).where(and(eq(reconciliations.id, id), eq(reconciliations.orgId, actor.orgId))).limit(1);
      if (!cur) throw new NotFoundError('Reconciliation');
      throw new ConflictError('RECONCILIATION_CLOSED', 'This reconciliation is already closed');
    }
    await audit(tx, actor, { action: 'reconciliation.closed', entityType: 'reconciliation', entityId: id, reason: note ?? null });
    return row;
  });
}

export async function countViews(db: Db, orgId: string, filter: { reconciliationId?: string; countId?: string }) {
  const rows = rowsOf<Record<string, any>>(await db.execute(sql`
    select rc.*, i.item_number, i.name as item_name, i.type as item_type, ch.name as counted_by_name
    from (${countsResolved(orgId)}) rc
    join items i on i.id = rc.item_id
    left join holders ch on ch.user_id = rc.counted_by and ch.org_id = rc.org_id
    where true ${filter.reconciliationId ? sql`and rc.reconciliation_id = ${filter.reconciliationId}` : sql``} ${filter.countId ? sql`and rc.id = ${filter.countId}` : sql``}
    order by rc.created_at desc, rc.id desc limit 1000`));
  return rows.map((r) => ({
    id: r.id, itemId: r.item_id, itemNumber: r.item_number, itemName: r.item_name, systemQuantity: r.system_quantity, physicalQuantity: r.physical_quantity, variance: r.variance,
    reason: r.reason, note: r.note, resolution: r.resolution as 'matched' | 'adjusted' | 'pending_approval' | 'rejected' | 'unresolved',
    countedBy: { id: r.counted_by, name: r.counted_by_name ?? null }, ledgerTransactionId: r.ledger_transaction_id, adjustmentTransactionId: r.adjustment_transaction_id,
    pendingApprovalId: r.pending_approval_id, createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function countForLedger(db: Db, orgId: string, ledgerTxId: string) {
  const [c] = await db.select({ id: reconciliationCounts.id }).from(reconciliationCounts).where(and(eq(reconciliationCounts.orgId, orgId), eq(reconciliationCounts.ledgerTransactionId, ledgerTxId))).limit(1);
  return (await countViews(db, orgId, { countId: c.id }))[0];
}

export async function listReconciliations(db: Db, orgId: string, q: { status?: 'open' | 'closed'; cursor?: string; limit: number }) {
  const rows = await db.select().from(reconciliations).where(and(
    eq(reconciliations.orgId, orgId), q.status ? eq(reconciliations.status, q.status) : undefined,
    q.cursor ? keysetWhere(reconciliations.startedAt, reconciliations.id, q.cursor) : undefined,
  )).orderBy(desc(reconciliations.startedAt), desc(reconciliations.id)).limit(q.limit + 1);
  const page = toPage(rows.map((r) => ({ ...r, createdAt: r.startedAt })), q.limit);
  return { items: page.items as typeof rows, nextCursor: page.nextCursor };
}

export async function getReconciliation(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(reconciliations).where(and(eq(reconciliations.id, id), eq(reconciliations.orgId, orgId))).limit(1);
  if (!row) throw new NotFoundError('Reconciliation');
  const counts = await countViews(db, orgId, { reconciliationId: id });
  const latest = new Map<string, (typeof counts)[number]>();
  for (const c of [...counts].reverse()) latest.set(c.itemId, c); // counts are newest-first; keep the newest per item
  const finals = [...latest.values()];
  return {
    row, counts,
    summary: {
      counted: finals.length, matched: finals.filter((c) => c.variance === 0).length, discrepancies: finals.filter((c) => c.variance !== 0).length,
      adjusted: finals.filter((c) => c.resolution === 'adjusted').length, pendingApproval: finals.filter((c) => c.resolution === 'pending_approval').length,
      unresolved: finals.filter((c) => c.variance !== 0 && !['adjusted', 'pending_approval'].includes(c.resolution)).length,
    },
  };
}

/** The checklist for a counting session: every active item in scope, its system quantity, and whether it has been counted yet. */
export async function expectedItems(db: Db, orgId: string, id: string, q: { cursor?: string; limit: number }) {
  const [rec_] = await db.select().from(reconciliations).where(and(eq(reconciliations.id, id), eq(reconciliations.orgId, orgId))).limit(1);
  if (!rec_) throw new NotFoundError('Reconciliation');
  const scope = rec_.scope === 'item' ? sql`i.id = ${rec_.scopeId}` : rec_.scope === 'category' ? sql`i.category_id = ${rec_.scopeId}` : rec_.scope === 'shelf' ? sql`i.category_id in (select id from categories where shelf_id = ${rec_.scopeId})` : sql`i.location_id = ${rec_.scopeId}`;
  const cur = q.cursor ? Buffer.from(q.cursor, 'base64url').toString().split('|') : null;
  const rows = rowsOf<Record<string, any>>(await db.execute(sql`
    select i.id, i.item_number, i.name, i.type, i.unit, i.created_at,
           case when i.type = 'consumable' then i.quantity_available when i.asset_state = 'available' then 1 else 0 end as system_quantity,
           exists (select 1 from reconciliation_counts c where c.reconciliation_id = ${id} and c.item_id = i.id) as counted
    from items i where i.org_id = ${orgId} and i.archived_at is null and ${scope}
      ${cur ? sql`and (i.created_at, i.id) < (${cur[0]}::timestamptz, ${cur[1]}::uuid)` : sql``}
    order by i.created_at desc, i.id desc limit ${q.limit + 1}`));
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ itemId: r.id, itemNumber: r.item_number, name: r.name, type: r.type as 'asset' | 'consumable', unit: r.unit, systemQuantity: r.system_quantity as number, counted: r.counted as boolean })),
    nextCursor: hasMore && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url') : null,
  };
}
void transactions; void pendingApprovals;
