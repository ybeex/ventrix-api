/** Request-body schemas for the ledger operations — shared by the online endpoints and the offline-sync validator. */
import { Type } from '@sinclair/typebox';
import { IsoDate, Obj, Uuid, lits } from '../../lib/strict.js';
import { ConditionSchema, ReasonSchema } from './views.js';

export const Qty = Type.Integer({ minimum: 1, maximum: 10_000_000 });
export const Note = Type.String({ minLength: 1, maxLength: 2000 });
const Short = (n: number) => Type.String({ minLength: 1, maxLength: n });
const Snapshot = Type.Optional(Uuid);

export const CheckoutBody = Obj({ itemId: Uuid, holderId: Uuid, quantity: Type.Optional(Qty), jobId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), purpose: Type.Optional(Short(300)), note: Type.Optional(Note), dueAt: Type.Optional(IsoDate), snapshotFileId: Snapshot, override: Type.Optional(Type.Boolean()) });
export const BatchCheckoutBody = Obj({
  holderId: Uuid, lines: Type.Array(Obj({ itemId: Uuid, quantity: Type.Optional(Qty) }), { minItems: 1, maxItems: 100 }),
  jobId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), purpose: Type.Optional(Short(300)), note: Type.Optional(Note), dueAt: Type.Optional(IsoDate), snapshotFileId: Snapshot,
});
export const CheckinBody = Obj({ itemId: Uuid, holderId: Type.Optional(Uuid), quantity: Type.Optional(Qty), condition: Type.Optional(ConditionSchema), jobId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), note: Type.Optional(Note), snapshotFileId: Snapshot, overrideOverReturn: Type.Optional(Type.Boolean()) });
export const ConsumeBody = Obj({ itemId: Uuid, quantity: Qty, holderId: Type.Optional(Uuid), jobId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), purpose: Type.Optional(Short(300)), note: Type.Optional(Note), snapshotFileId: Snapshot });
export const RestockBody = Obj({ itemId: Uuid, quantity: Qty, reference: Type.Optional(Short(200)), locationId: Type.Optional(Uuid), note: Type.Optional(Note), snapshotFileId: Snapshot });
export const AdjustBody = Obj({ itemId: Uuid, quantityDelta: Type.Integer({ minimum: -10_000_000, maximum: 10_000_000 }), reason: ReasonSchema, note: Type.Optional(Note), locationId: Type.Optional(Uuid), snapshotFileId: Snapshot });
export const IncidentBody = Obj({ itemId: Uuid, note: Note, quantity: Type.Optional(Qty), holderId: Type.Optional(Uuid), jobId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), snapshotFileId: Snapshot });
export const ConditionBody = Obj({ itemId: Uuid, toState: Type.Optional(lits(['available', 'damaged', 'under_repair', 'retired'])), condition: Type.Optional(ConditionSchema), note: Note, snapshotFileId: Snapshot });
