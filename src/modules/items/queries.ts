import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, holders, items, shelves, transactions } from '../../db/schema.js';
import { NotFoundError } from '../../lib/errors.js';
import { decodeSeqCursor, keysetWhere, toPage, toSeqPage } from '../../lib/pagination.js';
import { contains, prefix } from '../../lib/sql.js';
import { actorHolder, subjectHolder } from '../transactions/views.js';

/** One effective-minimum rule everywhere (list, low-stock view, dashboard, reports): item override, else category default, else not monitored. */
export const effectiveMin = sql<number | null>`coalesce(${items.minQuantity}, ${categories.defaultMinQuantity})`;

export const itemSelect = {
  item: items,
  categoryName: categories.name,
  shelfId: categories.shelfId,
  shelfName: shelves.name,
  holderName: holders.name,
  effectiveMin,
};
export type ItemJoined = { item: typeof items.$inferSelect; categoryName: string | null; shelfId: string | null; shelfName: string | null; holderName: string | null; effectiveMin: number | null };

export const fromItems = (db: Db) =>
  db.select(itemSelect).from(items)
    .leftJoin(categories, eq(categories.id, items.categoryId))
    .leftJoin(shelves, eq(shelves.id, categories.shelfId))
    .leftJoin(holders, eq(holders.id, items.currentHolderId));

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export type ItemViewSettings = number | { dueSoonHours: number; nearMinimumPercent?: number };
export function serializeItem(r: ItemJoined, settings: ItemViewSettings, now = new Date()) {
  const dueSoonHours = typeof settings === 'number' ? settings : settings.dueSoonHours;
  const nearPct = typeof settings === 'number' ? 0 : settings.nearMinimumPercent ?? 0;
  const i = r.item;
  const qty = i.quantityAvailable ?? 0;
  const lowStock = i.type === 'consumable' && r.effectiveMin !== null && qty <= r.effectiveMin;
  const nearMinimum = !lowStock && i.type === 'consumable' && nearPct > 0 && r.effectiveMin !== null && r.effectiveMin > 0 && qty <= r.effectiveMin + Math.ceil((r.effectiveMin * nearPct) / 100);
  let dueStatus: 'on_time' | 'due_soon' | 'overdue' | null = null;
  if (i.assetState === 'checked_out') {
    dueStatus = !i.dueAt ? 'on_time' : i.dueAt < now ? 'overdue' : i.dueAt.getTime() - now.getTime() <= dueSoonHours * 3_600_000 ? 'due_soon' : 'on_time';
  }
  return {
    id: i.id, itemNumber: i.itemNumber, type: i.type, sku: i.sku, code: i.code, name: i.name, description: i.description,
    categoryId: i.categoryId, categoryName: r.categoryName, shelfId: r.shelfId, shelfName: r.shelfName, locationId: i.locationId, photoFileId: i.photoFileId, unit: i.unit,
    assetState: i.assetState, condition: i.condition,
    currentHolder: i.currentHolderId ? { id: i.currentHolderId, name: r.holderName ?? '' } : null,
    currentJobId: i.currentJobId, checkedOutAt: iso(i.checkedOutAt), dueAt: iso(i.dueAt), dueStatus, expectedReturnHours: i.expectedReturnHours,
    quantityAvailable: i.quantityAvailable, minQuantity: i.minQuantity, effectiveMinQuantity: r.effectiveMin, reorderQuantity: i.reorderQuantity, lowStock, nearMinimum,
    archivedAt: iso(i.archivedAt), createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
  };
}

export async function getItemJoined(db: Db, orgId: string, id: string): Promise<ItemJoined> {
  const [row] = await fromItems(db).where(and(eq(items.id, id), eq(items.orgId, orgId))).limit(1);
  if (!row) throw new NotFoundError('Item');
  return row;
}

export interface ItemFilters {
  q?: string; type?: 'asset' | 'consumable'; categoryId?: string; shelfId?: string; locationId?: string; holderId?: string;
  status?: 'available' | 'checked_out' | 'lost' | 'damaged' | 'under_repair' | 'retired';
  lowStock?: boolean; archived?: 'exclude' | 'include' | 'only'; cursor?: string; limit: number;
}

export async function listItems(db: Db, orgId: string, f: ItemFilters) {
  const q = f.q?.trim();
  const search: SQL | undefined = q
    ? or(
        sql`${items.name} ilike ${contains(q)}`, sql`${items.sku} ilike ${contains(q)}`, sql`${items.itemNumber} ilike ${contains(q)}`,
        sql`${items.code} ilike ${prefix(q)}`, sql`${items.id}::text ilike ${prefix(q)}`,
        sql`${categories.name} ilike ${contains(q)}`, sql`${shelves.name} ilike ${contains(q)}`, sql`${holders.name} ilike ${contains(q)}`,
      )
    : undefined;
  const archived = f.archived ?? 'exclude';
  const rows = await fromItems(db).where(and(
    eq(items.orgId, orgId), search,
    f.type ? eq(items.type, f.type) : undefined, f.categoryId ? eq(items.categoryId, f.categoryId) : undefined, f.shelfId ? eq(categories.shelfId, f.shelfId) : undefined,
    f.locationId ? eq(items.locationId, f.locationId) : undefined, f.holderId ? eq(items.currentHolderId, f.holderId) : undefined,
    f.status ? eq(items.assetState, f.status) : undefined,
    f.lowStock ? sql`${items.type} = 'consumable' and ${effectiveMin} is not null and ${items.quantityAvailable} <= ${effectiveMin}` : undefined,
    archived === 'exclude' ? isNull(items.archivedAt) : archived === 'only' ? isNotNull(items.archivedAt) : undefined,
    f.cursor ? keysetWhere(items.createdAt, items.id, f.cursor) : undefined,
  )).orderBy(desc(items.createdAt), desc(items.id)).limit(f.limit + 1);
  const page = toPage(rows.map((r) => ({ ...r, id: r.item.id, createdAt: r.item.createdAt })), f.limit);
  return { rows: page.items as ItemJoined[], nextCursor: page.nextCursor };
}

/** Exact scan/lookup: scannable code first (active item preferred), then the human Item ID, case-insensitively. */
export async function lookupByCode(db: Db, orgId: string, code: string): Promise<ItemJoined> {
  const c = code.trim();
  const order = [sql`(${items.archivedAt} is not null)`, desc(items.createdAt)];
  const [byCode] = await fromItems(db).where(and(eq(items.orgId, orgId), eq(items.code, c))).orderBy(...order).limit(1);
  if (byCode) return byCode;
  const [byNumber] = await fromItems(db).where(and(eq(items.orgId, orgId), sql`upper(${items.itemNumber}) = upper(${c})`)).limit(1);
  if (!byNumber) throw new NotFoundError('Item');
  return byNumber;
}

export async function itemTimeline(db: Db, orgId: string, itemId: string, q: { cursor?: string; limit: number }) {
  const rows = await db.select({ tx: transactions, actorName: actorHolder.name, holderName: subjectHolder.name })
    .from(transactions)
    .leftJoin(actorHolder, and(eq(actorHolder.userId, transactions.actorUserId), eq(actorHolder.orgId, transactions.orgId)))
    .leftJoin(subjectHolder, eq(subjectHolder.id, transactions.holderId))
    .where(and(eq(transactions.orgId, orgId), eq(transactions.itemId, itemId), q.cursor ? sql`${transactions.seq} < ${decodeSeqCursor(q.cursor)}` : undefined))
    .orderBy(desc(transactions.seq)).limit(q.limit + 1);
  const page = toSeqPage(rows.map((r) => ({ ...r, seq: r.tx.seq })), q.limit);
  return { rows: page.items, nextCursor: page.nextCursor };
}

export async function recentItems(db: Db, orgId: string, actorId: string, limit: number) {
  const recent = db.select({ itemId: transactions.itemId, last: sql<number>`max(${transactions.seq})`.as('last') }).from(transactions)
    .where(and(eq(transactions.orgId, orgId), eq(transactions.actorUserId, actorId), sql`${transactions.createdAt} > now() - interval '30 days'`, sql`${transactions.type} not in ('create','archive','restore')`))
    .groupBy(transactions.itemId).as('recent');
  return fromItems(db).innerJoin(recent, eq(recent.itemId, items.id))
    .where(and(eq(items.orgId, orgId), isNull(items.archivedAt))).orderBy(desc(recent.last)).limit(limit);
}
