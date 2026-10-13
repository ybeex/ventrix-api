/**
 * PRD §40 reports. Each report is ONE definition (`page`) that yields flat rows; the JSON endpoint serves a page,
 * the CSV endpoint streams every page — so the two can never differ. Reports read the source tables directly
 * (never a separate derived store), so they always agree with the live views.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { decodeSeqCursor } from '../../lib/pagination.js';
import { contains, toDate, ts } from '../../lib/sql.js';
import { listItems } from '../items/queries.js';
import { countsResolved, isOpen } from '../reconciliation/queries.js';
import { outstandingPage, lowStockPage } from '../operations/queries.js';
import { listTransactions } from '../transactions/service.js';

export type Row = Record<string, unknown>;
export interface Page { rows: Row[]; nextCursor: string | null }
export interface ReportDef {
  name: string; title: string; description: string;
  columns: Array<{ key: string; label: string }>;
  page: (db: Db, orgId: string, filters: Record<string, any>, cursor: string | undefined, limit: number) => Promise<Page>;
}

const iso = (d: unknown) => toDate(d)?.toISOString() ?? '';
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

export const REPORTS: Record<string, ReportDef> = {
  inventory: {
    name: 'inventory', title: 'Inventory', description: 'Every item with its type, current quantity or status, location and minimum level.',
    columns: [
      { key: 'itemNumber', label: 'Item ID' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'shelf', label: 'Shelf' }, { key: 'category', label: 'Category' },
      { key: 'quantity', label: 'Quantity' }, { key: 'unit', label: 'Unit' }, { key: 'status', label: 'Status' }, { key: 'holder', label: 'Current holder' },
      { key: 'location', label: 'Location' }, { key: 'minimum', label: 'Minimum level' }, { key: 'lowStock', label: 'Low stock' },
    ],
    async page(db, orgId, f, cursor, limit) {
      const { rows, nextCursor } = await listItems(db, orgId, { type: f.type, categoryId: f.categoryId, lowStock: f.lowStockOnly, archived: 'exclude', cursor, limit });
      const locs = rowsOf<{ id: string; name: string }>(await db.execute(sql`select id, name from locations where org_id = ${orgId}`));
      const locName = new Map(locs.map((l) => [l.id, l.name]));
      return {
        nextCursor,
        rows: rows.map((r) => ({
          itemNumber: r.item.itemNumber, name: r.item.name, type: r.item.type, shelf: r.shelfName ?? '', category: r.categoryName ?? '', quantity: r.item.quantityAvailable ?? '', unit: r.item.type === 'consumable' ? r.item.unit : '',
          status: r.item.assetState ?? '', holder: r.holderName ?? '', location: locName.get(r.item.locationId) ?? '', minimum: r.effectiveMin ?? '',
          lowStock: r.item.type === 'consumable' && r.effectiveMin !== null && (r.item.quantityAvailable ?? 0) <= r.effectiveMin ? 'yes' : 'no',
        })),
      };
    },
  },
  outstanding: {
    name: 'outstanding', title: 'Outstanding items', description: 'Everything currently checked out, by holder, with due dates and overdue flags.',
    columns: [
      { key: 'holder', label: 'Holder' }, { key: 'holderKind', label: 'Holder type' }, { key: 'itemNumber', label: 'Item ID' }, { key: 'item', label: 'Item' },
      { key: 'quantity', label: 'Quantity' }, { key: 'since', label: 'Checked out' }, { key: 'dueAt', label: 'Due' }, { key: 'overdue', label: 'Overdue' },
    ],
    async page(db, orgId, f, cursor, limit) {
      const { rows, nextCursor } = await outstandingPage(db, orgId, { holderId: f.holderId, type: f.type, overdueOnly: f.overdueOnly, cursor, limit });
      return { nextCursor, rows: rows.map((r) => ({ holder: r.holder_name, holderKind: r.holder_kind, itemNumber: r.item_number, item: r.item_name, quantity: r.quantity, since: iso(r.since), dueAt: iso(r.due_at), overdue: r.overdue ? 'yes' : 'no' })) };
    },
  },
  'low-stock': {
    name: 'low-stock', title: 'Low stock', description: 'Consumables at or below their minimum, furthest below first.',
    columns: [
      { key: 'itemNumber', label: 'Item ID' }, { key: 'item', label: 'Item' }, { key: 'category', label: 'Category' }, { key: 'quantity', label: 'Quantity' },
      { key: 'minimum', label: 'Minimum' }, { key: 'shortfall', label: 'Below minimum by' }, { key: 'reorder', label: 'Reorder quantity' },
    ],
    async page(db, orgId, _f, cursor, limit) {
      const { rows, nextCursor } = await lowStockPage(db, orgId, { cursor, limit });
      return { nextCursor, rows: rows.map((r) => ({ itemNumber: r.item_number, item: r.item_name, category: r.category_name ?? '', quantity: r.quantity, minimum: r.minimum, shortfall: r.minimum - r.quantity, reorder: r.reorder_quantity ?? '' })) };
    },
  },
  transactions: {
    name: 'transactions', title: 'Transactions', description: 'The ledger, filterable by date, type, item, holder and actor.',
    columns: [
      { key: 'when', label: 'Time (UTC)' }, { key: 'type', label: 'Type' }, { key: 'itemNumber', label: 'Item ID' }, { key: 'item', label: 'Item' }, { key: 'quantity', label: 'Quantity' },
      { key: 'stockDelta', label: 'Stock change' }, { key: 'holder', label: 'Holder' }, { key: 'actor', label: 'Performed by' }, { key: 'job', label: 'Job' }, { key: 'purpose', label: 'Purpose' }, { key: 'note', label: 'Note' },
    ],
    async page(db, orgId, f, cursor, limit) {
      const { items, nextCursor } = await listTransactions(db, orgId, { itemId: f.itemId, type: f.type, holderId: f.holderId, actorId: f.actorId, jobId: f.jobId, from: f.from, to: f.to, cursor, limit });
      return { nextCursor, rows: items.map((t) => ({ when: t.createdAt, type: t.type, itemNumber: t.itemNumber ?? '', item: t.itemName ?? '', quantity: t.quantity ?? '', stockDelta: t.stockDelta, holder: t.holder?.name ?? '', actor: t.actor.name ?? '', job: t.jobId ?? '', purpose: t.purpose ?? '', note: t.note ?? '' })) };
    },
  },
  discrepancies: {
    name: 'discrepancies', title: 'Reconciliation discrepancies', description: 'Counts whose physical quantity differed from the system, with reason and resolution.',
    columns: [
      { key: 'when', label: 'Counted (UTC)' }, { key: 'itemNumber', label: 'Item ID' }, { key: 'item', label: 'Item' }, { key: 'system', label: 'System quantity' }, { key: 'physical', label: 'Physical quantity' },
      { key: 'variance', label: 'Variance' }, { key: 'reason', label: 'Reason' }, { key: 'resolution', label: 'Resolution' }, { key: 'resolvedBy', label: 'Resolved by' }, { key: 'countedBy', label: 'Counted by' },
    ],
    async page(db, orgId, f, cursor, limit) {
      const status: string = f.status ?? 'all';
      const [cAt, cId] = cursor ? Buffer.from(cursor, 'base64url').toString().split('|') : [null, null];
      const rows = rowsOf<Record<string, any>>(await db.execute(sql`
        select rc.*, i.item_number, i.name as item_name, ch.name as counted_by_name, rh.name as resolved_by_name
        from (${countsResolved(orgId)}) rc
        join items i on i.id = rc.item_id
        left join holders ch on ch.user_id = rc.counted_by and ch.org_id = rc.org_id
        left join holders rh on rh.user_id = rc.resolved_by and rh.org_id = rc.org_id
        where rc.variance <> 0
          ${status === 'open' ? sql`and ${isOpen}` : status === 'resolved' ? sql`and rc.resolution = 'adjusted'` : sql``}
          ${f.from ? sql`and rc.created_at >= ${ts(f.from)}` : sql``} ${f.to ? sql`and rc.created_at <= ${ts(f.to)}` : sql``}
          ${cAt ? sql`and (rc.created_at, rc.id) < (${ts(new Date(cAt))}, ${cId}::uuid)` : sql``}
        order by rc.created_at desc, rc.id desc limit ${limit + 1}`));
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        nextCursor: hasMore && last ? Buffer.from(`${toDate(last.created_at)!.toISOString()}|${last.id}`).toString('base64url') : null,
        rows: page.map((r) => ({ when: iso(r.created_at), itemNumber: r.item_number, item: r.item_name, system: r.system_quantity, physical: r.physical_quantity, variance: r.variance, reason: r.reason ?? '', resolution: r.resolution, resolvedBy: r.resolved_by_name ?? '', countedBy: r.counted_by_name ?? '' })),
      };
    },
  },
};

/** Streams every page of a report (CSV export). Bounded by a hard row ceiling so one export cannot exhaust the server. */
export const MAX_EXPORT_ROWS = 200_000;
export async function* allPages(def: ReportDef, db: Db, orgId: string, filters: Record<string, any>): AsyncGenerator<Row[]> {
  let cursor: string | undefined;
  let total = 0;
  do {
    const { rows, nextCursor } = await def.page(db, orgId, filters, cursor, 1000);
    total += rows.length;
    if (total > MAX_EXPORT_ROWS) throw new Error(`Export exceeds ${MAX_EXPORT_ROWS} rows; narrow the filters`);
    if (rows.length) yield rows;
    cursor = nextCursor ?? undefined;
  } while (cursor);
}
void decodeSeqCursor; void contains;
