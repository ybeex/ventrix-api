/**
 * Offline sync (PRD §21). A device queues operations while offline and replays them later:
 *
 *  - every action carries a client-generated id; the server derives the ledger idempotency key
 *    `sync:<device>:<clientGeneratedId>`, so re-sending a batch (flaky connection, app restart, double tap)
 *    can never create a duplicate or silently lose an action: it is applied, or recognised as already applied;
 *  - each action runs through the SAME operations/validation/approval policy as an online call, in its own
 *    transaction, with source='sync' and the device's claimed time stored separately from the server's receive time;
 *  - an action that cannot be applied safely (oversold, item already out, holder mismatch…) is NEVER auto-resolved:
 *    it is stored once as a sync issue for a supervisor, and reported back to the device as a conflict (never a
 *    batch-wide failure — one poison action must not block the ones behind it);
 *  - a retry that now succeeds (stock was restocked meanwhile) closes its own open issue.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, holders, items, jobs, locations, shelves, syncIssues, users } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { bodyAjv } from '../../lib/ajv.js';
import { audit } from '../../lib/audit.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { metrics } from '../../lib/metrics.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { fromItems } from '../items/queries.js';
import { getSettings } from '../organization/settings.service.js';
import type { OpMeta, OpResult } from '../transactions/engine.js';
import { checkin } from '../transactions/ops/checkin.js';
import { checkout } from '../transactions/ops/checkout.js';
import { adjust, reportDamage, reportLoss, updateCondition } from '../transactions/ops/incidents.js';
import { consume, restock } from '../transactions/ops/stock.js';
import * as S from '../transactions/schemas.js';

type Runner = (db: Db, actor: Actor, key: string, payload: never, meta?: OpMeta) => Promise<OpResult>;
export const SYNC_OPS: Record<string, { schema: object; run: Runner }> = {
  checkout: { schema: S.CheckoutBody, run: checkout as Runner },
  checkin: { schema: S.CheckinBody, run: checkin as Runner },
  consume: { schema: S.ConsumeBody, run: consume as Runner },
  restock: { schema: S.RestockBody, run: restock as Runner },
  adjustment: { schema: S.AdjustBody, run: adjust as Runner },
  loss: { schema: S.IncidentBody, run: reportLoss as Runner },
  damage: { schema: S.IncidentBody, run: reportDamage as Runner },
  condition: { schema: S.ConditionBody, run: updateCondition as Runner },
};
const validators = new Map<string, ReturnType<typeof bodyAjv.compile>>();
const validatorFor = (type: string) => { let v = validators.get(type); if (!v) { v = bodyAjv.compile(SYNC_OPS[type].schema); validators.set(type, v); } return v; };

export interface QueuedAction { clientGeneratedId: string; type: string; queuedAt: string; payload: unknown }
export type ActionOutcome =
  | { clientGeneratedId: string; status: 'applied' | 'duplicate'; transactionId: string }
  | { clientGeneratedId: string; status: 'pending_approval'; approvalId: string }
  | { clientGeneratedId: string; status: 'conflict' | 'rejected'; issueId: string; code: string; message: string };

export const syncKey = (deviceId: string, clientId: string) => `sync:${deviceId}:${clientId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The payload is untrusted device input: only a well-formed UUID may be copied into a uuid column (or a malformed one poisons the whole batch with a 500). */
const itemIdOf = (payload: unknown): string | null => {
  const v = (payload as { itemId?: unknown } | null)?.itemId;
  return typeof v === 'string' && UUID.test(v) ? v : null;
};

async function recordIssue(db: Db, actor: Actor, deviceId: string, a: QueuedAction, kind: 'conflict' | 'rejected', code: string, message: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(syncIssues).values({
      orgId: actor.orgId, kind, deviceId, actorUserId: actor.id, clientGeneratedId: a.clientGeneratedId, operation: a.type,
      itemId: itemIdOf(a.payload),
      payload: { queuedAt: a.queuedAt, payload: a.payload }, code, message,
    }).onConflictDoNothing().returning({ id: syncIssues.id });
    if (!row) { // a retry of an action already recorded: same issue, no second row, no second notification
      const [ex] = await tx.select({ id: syncIssues.id }).from(syncIssues).where(and(eq(syncIssues.orgId, actor.orgId), eq(syncIssues.deviceId, deviceId), eq(syncIssues.clientGeneratedId, a.clientGeneratedId))).limit(1);
      return ex.id;
    }
    await audit(tx, actor, { action: `sync.${kind}`, entityType: 'sync_issue', entityId: row.id, next: { operation: a.type, code, deviceId } });
    await emitEvent(tx, actor.orgId, { type: 'sync.issue', issueId: row.id, kind, code, itemId: itemIdOf(a.payload), actorUserId: actor.id, deviceId });
    return row.id;
  });
}

async function applyOne(db: Db, actor: Actor, deviceId: string, a: QueuedAction): Promise<ActionOutcome> {
  const id = a.clientGeneratedId;
  const reject = async (code: string, message: string): Promise<ActionOutcome> => {
    metrics.syncActions.inc({ outcome: 'rejected' });
    return { clientGeneratedId: id, status: 'rejected', issueId: await recordIssue(db, actor, deviceId, a, 'rejected', code, message), code, message };
  };
  const op = SYNC_OPS[a.type];
  if (!op) return reject('UNKNOWN_OPERATION', `Unknown operation "${a.type}"`);
  const validate = validatorFor(a.type);
  if (!validate(a.payload)) return reject('VALIDATION_ERROR', `Invalid ${a.type} payload: ${bodyAjv.errorsText(validate.errors, { dataVar: 'payload' })}`.slice(0, 400));
  try {
    const r = await op.run(db, actor, syncKey(deviceId, id), a.payload as never, { source: 'sync', occurredAt: new Date(a.queuedAt), deviceId });
    // If this action had previously failed and now succeeds, the open issue closes itself.
    await db.update(syncIssues).set({ status: 'resolved_applied_client', resolvedAt: new Date(), resolutionNote: 'Applied automatically on retry', resultingTransactionId: r.status === 'committed' ? r.primary.id : null })
      .where(and(eq(syncIssues.orgId, actor.orgId), eq(syncIssues.deviceId, deviceId), eq(syncIssues.clientGeneratedId, id), eq(syncIssues.status, 'open')));
    if (r.status === 'pending_approval') { metrics.syncActions.inc({ outcome: 'pending_approval' }); return { clientGeneratedId: id, status: 'pending_approval', approvalId: r.approval.id }; }
    metrics.syncActions.inc({ outcome: r.replayed ? 'replayed' : 'applied' });
    return { clientGeneratedId: id, status: r.replayed ? 'duplicate' : 'applied', transactionId: r.primary.id };
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode >= 500) throw err; // infrastructure problem: fail the call, the device retries safely
    // A 409 about STATE (stock, holder, availability) is a conflict a human can resolve; reusing an id for a different request is a client bug.
    const kind = err.statusCode === 409 && err.code !== 'IDEMPOTENCY_KEY_REUSED' ? 'conflict' : 'rejected';
    metrics.syncActions.inc({ outcome: kind });
    return { clientGeneratedId: id, status: kind, issueId: await recordIssue(db, actor, deviceId, a, kind, err.code, err.message), code: err.code, message: err.message };
  }
}

export async function processBatch(db: Db, actor: Actor, deviceId: string, actions: QueuedAction[]): Promise<ActionOutcome[]> {
  const ids = actions.map((a) => a.clientGeneratedId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('clientGeneratedId must be unique within a batch');
  const out: ActionOutcome[] = [];
  for (const a of actions) out.push(await applyOne(db, actor, deviceId, a)); // queue order is the device's FIFO order
  return out;
}

// ── Conflict review ────────────────────────────────────────────────

const view = (r: typeof syncIssues.$inferSelect, actorName: string | null) => ({
  id: r.id, kind: r.kind, status: r.status, deviceId: r.deviceId, actor: { id: r.actorUserId, name: actorName }, clientGeneratedId: r.clientGeneratedId,
  operation: r.operation, itemId: r.itemId, payload: r.payload, code: r.code, message: r.message, detectedAt: r.detectedAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote, resultingTransactionId: r.resultingTransactionId,
});

export async function listIssues(db: Db, orgId: string, q: { status?: 'open' | 'resolved'; cursor?: string; limit: number }) {
  const rows = await db.select({ r: syncIssues, name: holders.name }).from(syncIssues)
    .leftJoin(holders, and(eq(holders.userId, syncIssues.actorUserId), eq(holders.orgId, syncIssues.orgId)))
    .where(and(eq(syncIssues.orgId, orgId), q.status === 'open' ? eq(syncIssues.status, 'open') : q.status === 'resolved' ? sql`${syncIssues.status} <> 'open'` : undefined,
      q.cursor ? keysetWhere(syncIssues.detectedAt, syncIssues.id, q.cursor) : undefined))
    .orderBy(desc(syncIssues.detectedAt), desc(syncIssues.id)).limit(q.limit + 1);
  const page = toPage(rows.map((x) => ({ ...x, id: x.r.id, createdAt: x.r.detectedAt })), q.limit);
  return { items: (page.items as typeof rows).map((x) => view(x.r, x.name)), nextCursor: page.nextCursor };
}

export async function resolveIssue(db: Db, reviewer: Actor, id: string, input: { resolution: 'keep_server' | 'apply_client'; note: string }) {
  const [issue] = await db.select().from(syncIssues).where(and(eq(syncIssues.id, id), eq(syncIssues.orgId, reviewer.orgId))).limit(1);
  if (!issue) throw new NotFoundError('Sync issue');
  if (issue.status !== 'open') throw new ConflictError('ISSUE_RESOLVED', `This issue is already ${issue.status.replace('resolved_', 'resolved: ')}`);

  let txId: string | null = null;
  let status: 'resolved_kept_server' | 'resolved_applied_client' = 'resolved_kept_server';
  if (input.resolution === 'apply_client') {
    // Re-attempt as the ORIGINAL person (the ledger must name who actually did it, not the reviewer). Still subject to every rule:
    // if the world still forbids it the reviewer gets the same conflict back and the issue stays open.
    const [u] = await db.select().from(users).where(and(eq(users.id, issue.actorUserId), eq(users.orgId, reviewer.orgId))).limit(1);
    if (!u || !u.active) throw new ConflictError('ACTOR_INACTIVE', 'The person who recorded this action is no longer active; keep the server state instead');
    const op = SYNC_OPS[issue.operation];
    if (!op) throw new ConflictError('UNKNOWN_OPERATION', 'This operation can no longer be replayed');
    const stored = issue.payload as { queuedAt: string; payload: never };
    const r = await op.run(db, { id: u.id, orgId: u.orgId, role: u.role, requestId: reviewer.requestId, ip: reviewer.ip }, syncKey(issue.deviceId, issue.clientGeneratedId), stored.payload, { source: 'sync', occurredAt: new Date(stored.queuedAt), deviceId: issue.deviceId });
    txId = r.status === 'committed' ? r.primary.id : null;
    status = 'resolved_applied_client';
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.update(syncIssues).set({ status, resolvedAt: new Date(), resolvedBy: reviewer.id, resolutionNote: input.note, resultingTransactionId: txId })
      .where(and(eq(syncIssues.id, id), eq(syncIssues.status, 'open'))).returning();
    if (!row) throw new ConflictError('ISSUE_RESOLVED', 'This issue was just resolved by someone else');
    await audit(tx, reviewer, { action: 'sync.resolved', entityType: 'sync_issue', entityId: id, transactionId: txId, reason: input.note, next: { resolution: input.resolution } });
    const [h] = await tx.select({ name: holders.name }).from(holders).where(and(eq(holders.userId, row.actorUserId), eq(holders.orgId, row.orgId))).limit(1);
    return view(row, h?.name ?? null);
  });
}

// ── Offline cache (delta snapshots) ────────────────────────────────

export const encodeCur = (d: Date, id: string) => Buffer.from(`${d.toISOString()}|${id}`).toString('base64url');
export function decodeCur(cursor?: string, since?: string): { at: Date; id: string } | null {
  if (cursor) {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new ValidationError('Malformed sync cursor');
    return { at, id };
  }
  return since ? { at: new Date(since), id: '00000000-0000-0000-0000-000000000000' } : null;
}

/**
 * Items changed after the cursor, oldest-change-first, archived ones included (the client marks them inactive).
 * Duplicates across pages are possible by design (the cursor has millisecond precision) and harmless: the client upserts by id.
 */
export async function itemDelta(db: Db, orgId: string, q: { cursor?: string; since?: string; limit: number }) {
  const cur = decodeCur(q.cursor, q.since);
  const rows = await fromItems(db).where(and(eq(items.orgId, orgId), cur ? sql`(${items.updatedAt}, ${items.id}) > (${cur.at.toISOString()}::timestamptz, ${cur.id}::uuid)` : undefined))
    .orderBy(asc(items.updatedAt), asc(items.id)).limit(q.limit + 1);
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page.at(-1);
  return { rows: page, hasMore, cursor: last ? encodeCur(last.item.updatedAt, last.item.id) : q.cursor ?? null };
}

export async function holderDelta(db: Db, orgId: string, q: { cursor?: string; since?: string; limit: number }) {
  const cur = decodeCur(q.cursor, q.since);
  const rows = await db.select().from(holders).where(and(eq(holders.orgId, orgId), cur ? sql`(${holders.updatedAt}, ${holders.id}) > (${cur.at.toISOString()}::timestamptz, ${cur.id}::uuid)` : undefined))
    .orderBy(asc(holders.updatedAt), asc(holders.id)).limit(q.limit + 1);
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page.at(-1);
  return { rows: page, hasMore, cursor: last ? encodeCur(last.updatedAt, last.id) : q.cursor ?? null };
}

export async function referenceData(db: Db, orgId: string) {
  const [cats, shelfRows, locs, jobRows, settings] = await Promise.all([
    db.select().from(categories).where(eq(categories.orgId, orgId)), db.select().from(shelves).where(eq(shelves.orgId, orgId)), db.select().from(locations).where(eq(locations.orgId, orgId)),
    db.select().from(jobs).where(eq(jobs.orgId, orgId)), getSettings(db, orgId),
  ]);
  return { shelves: shelfRows, categories: cats, locations: locs, jobs: jobRows, settings };
}
