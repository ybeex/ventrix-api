import { Type } from '@sinclair/typebox';
import { alias } from 'drizzle-orm/pg-core';
import { holders, transactions } from '../../db/schema.js';
import { IsoDate, Nullable, Obj, Uuid, lits } from '../../lib/strict.js';
import { summarizeTx } from '../../lib/describe.js';
export const AssetState = lits(['available', 'checked_out', 'lost', 'damaged', 'under_repair', 'retired']);
export const ConditionSchema = lits(['good', 'damaged', 'needs_inspection', 'replaced']);
export const TxType = lits(['checkout', 'checkin', 'consume', 'restock', 'adjustment', 'create', 'archive', 'restore', 'condition_update', 'loss', 'damage', 'reconciliation', 'correction']);
export const ReasonSchema = lits(['count_correction', 'opening_balance_correction', 'unrecorded_movement', 'damage', 'loss', 'other']);

export const TxView = Obj({
  id: Uuid, sequence: Type.Integer(), summary: Type.String(), type: TxType, itemId: Uuid, itemNumber: Nullable(Type.String()), itemName: Nullable(Type.String()),
  quantity: Nullable(Type.Integer()), stockDelta: Type.Integer(), custodyDelta: Type.Integer(),
  balanceBefore: Nullable(Type.Integer()), balanceAfter: Nullable(Type.Integer()),
  stateBefore: Nullable(AssetState), stateAfter: Nullable(AssetState),
  actor: Obj({ id: Uuid, name: Nullable(Type.String()) }),
  holder: Nullable(Obj({ id: Uuid, name: Type.String() })),
  locationId: Uuid, jobId: Nullable(Uuid), condition: Nullable(ConditionSchema), reason: Nullable(ReasonSchema),
  purpose: Nullable(Type.String()), note: Nullable(Type.String()),
  correctsTransactionId: Nullable(Uuid), relatedTransactionId: Nullable(Uuid), dueAt: Nullable(IsoDate),
  snapshotFileId: Nullable(Uuid), approvedBy: Nullable(Uuid), overrideAuthorizedBy: Nullable(Uuid),
  source: lits(['online', 'sync']), deviceId: Nullable(Type.String()),
  occurredAt: IsoDate, createdAt: IsoDate,
});

/** Aliases for the two different humans on a ledger row: who DID it (actor) and who HAS it (holder). */
export const actorHolder = alias(holders, 'actor_holder');
export const subjectHolder = alias(holders, 'subject_holder');

type Joined = { tx: typeof transactions.$inferSelect; actorName: string | null; holderName: string | null; itemNumber?: string | null; itemName?: string | null };
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function serializeTx({ tx: t, actorName, holderName, itemNumber, itemName }: Joined) {
  return {
    id: t.id, sequence: t.seq, summary: summarizeTx(t, { actor: actorName, item: itemName ?? null, holder: holderName }), type: t.type, itemId: t.itemId, itemNumber: itemNumber ?? null, itemName: itemName ?? null,
    quantity: t.quantity, stockDelta: t.stockDelta, custodyDelta: t.custodyDelta,
    balanceBefore: t.balanceBefore, balanceAfter: t.balanceAfter, stateBefore: t.stateBefore, stateAfter: t.stateAfter,
    actor: { id: t.actorUserId, name: actorName },
    holder: t.holderId ? { id: t.holderId, name: holderName ?? '' } : null,
    locationId: t.locationId, jobId: t.jobId, condition: t.condition, reason: t.reason, purpose: t.purpose, note: t.note,
    correctsTransactionId: t.correctsTransactionId, relatedTransactionId: t.relatedTransactionId, dueAt: iso(t.dueAt),
    snapshotFileId: t.snapshotFileId, approvedBy: t.approvedBy, overrideAuthorizedBy: t.overrideAuthorizedBy,
    source: t.source, deviceId: t.deviceId, occurredAt: t.occurredAt.toISOString(), createdAt: t.createdAt.toISOString(),
  };
}
