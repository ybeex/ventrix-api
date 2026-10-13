import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { items, transactions } from '../../db/schema.js';
import { NotFoundError } from '../../lib/errors.js';
import { decodeSeqCursor, toSeqPage } from '../../lib/pagination.js';
import type { TxRow } from './ledger.js';
import { actorHolder, serializeTx, subjectHolder } from './views.js';

const select = (db: Db) => db.select({ tx: transactions, actorName: actorHolder.name, holderName: subjectHolder.name, itemNumber: items.itemNumber, itemName: items.name })
  .from(transactions)
  .innerJoin(items, eq(items.id, transactions.itemId))
  .leftJoin(actorHolder, and(eq(actorHolder.userId, transactions.actorUserId), eq(actorHolder.orgId, transactions.orgId)))
  .leftJoin(subjectHolder, eq(subjectHolder.id, transactions.holderId));

/** Rows as returned to a client: with actor / holder / item names resolved, ordered by ledger sequence. */
export async function hydrateTx(db: Db, orgId: string, rows: TxRow[]) {
  if (rows.length === 0) return [];
  const got = await select(db).where(and(eq(transactions.orgId, orgId), inArray(transactions.id, rows.map((r) => r.id)))).orderBy(transactions.seq);
  return got.map(serializeTx);
}

export interface TxFilters {
  itemId?: string; type?: TxRow['type']; holderId?: string; actorId?: string; jobId?: string; from?: Date; to?: Date; cursor?: string; limit: number;
}

export const txWhere = (orgId: string, f: Omit<TxFilters, 'cursor' | 'limit'>) => and(
  eq(transactions.orgId, orgId),
  f.itemId ? eq(transactions.itemId, f.itemId) : undefined, f.type ? eq(transactions.type, f.type) : undefined,
  f.holderId ? eq(transactions.holderId, f.holderId) : undefined, f.actorId ? eq(transactions.actorUserId, f.actorId) : undefined,
  f.jobId ? eq(transactions.jobId, f.jobId) : undefined, f.from ? gte(transactions.createdAt, f.from) : undefined, f.to ? lte(transactions.createdAt, f.to) : undefined,
);

export async function listTransactions(db: Db, orgId: string, f: TxFilters) {
  const rows = await select(db).where(and(txWhere(orgId, f), f.cursor ? sql`${transactions.seq} < ${decodeSeqCursor(f.cursor)}` : undefined))
    .orderBy(desc(transactions.seq)).limit(f.limit + 1);
  const page = toSeqPage(rows.map((r) => ({ ...r, seq: r.tx.seq })), f.limit);
  return { items: page.items.map(serializeTx), nextCursor: page.nextCursor };
}

export async function getTransaction(db: Db, orgId: string, id: string) {
  const [row] = await select(db).where(and(eq(transactions.id, id), eq(transactions.orgId, orgId))).limit(1);
  if (!row) throw new NotFoundError('Transaction');
  return serializeTx(row);
}
