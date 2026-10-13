/**
 * The ONE place a ledger row is written. Every inventory-changing operation (checkout, consume,
 * adjustment, item creation, archive, correction, …) funnels through `recordTx`, which inserts the
 * immutable row and its audit event in the caller's DB transaction (PRD §24: "every material event
 * persists with an audit event"). Nothing else inserts into `transactions`.
 */
import type { Db } from '../../db/index.js';
import { transactions } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';

export type TxRow = typeof transactions.$inferSelect;
export type NewLedgerRow = Omit<typeof transactions.$inferInsert, 'id' | 'orgId' | 'actorUserId' | 'createdAt'>;

export interface LedgerActor { id: string; orgId: string; requestId?: string; ip?: string }

export async function recordTx(tx: Db, actor: LedgerActor, row: NewLedgerRow): Promise<TxRow> {
  const [created] = await tx.insert(transactions).values({ ...row, orgId: actor.orgId, actorUserId: actor.id }).returning();
  const stock = created.balanceAfter !== null || created.balanceBefore !== null;
  await audit(tx, actor, {
    action: `transaction.${created.type}`,
    entityType: 'item',
    entityId: created.itemId,
    previous: stock ? { quantity: created.balanceBefore } : { state: created.stateBefore },
    next: stock ? { quantity: created.balanceAfter } : { state: created.stateAfter },
    reason: created.note ?? created.reason ?? null,
    transactionId: created.id,
  });
  return created;
}
