/**
 * Operational views (PRD §26 outstanding, §27 overdue, §28 low stock). Each view has ONE SQL definition here; the dashboard
 * counts, the detail endpoints, Collections and the reports all read it, so totals always match lists.
 *
 * Outstanding = (a) every asset in state checked_out, plus (b) every (consumable, holder) whose ledger custody balance is
 * positive. A consumable line also carries issued / returned totals ("Partial return") and a DUE DATE: the due date of the
 * OLDEST issue that has not yet been fully returned (returns are applied to the earliest issues first — FIFO).
 * Overdue = an outstanding line whose due date has passed. Low stock = quantity at or below the effective minimum
 * (item minimum, else category default; no minimum ⇒ not monitored). Near minimum = above it, but within the org's
 * "close to minimum" band (organization_settings.near_minimum_percent of the minimum; 0 disables).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { ValidationError } from '../../lib/errors.js';
import { contains, toDate, ts } from '../../lib/sql.js';

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

/** `orgId` omitted ⇒ across all organizations (used only by the background overdue scan). */
export const outstandingCte = (orgId?: string) => {
  const io = orgId ? sql`and i.org_id = ${orgId}` : sql``;
  const to = orgId ? sql`and t.org_id = ${orgId}` : sql``;
  return sql`
  bal as (
    select t.item_id, t.holder_id, sum(t.custody_delta)::int as quantity,
           coalesce(sum(t.custody_delta) filter (where t.custody_delta > 0), 0)::int as issued_all,
           coalesce(sum(t.custody_delta) filter (where t.custody_delta > 0 and t.type <> 'correction'), 0)::int as issued,
           coalesce(sum(-t.custody_delta) filter (where t.custody_delta < 0 and t.type <> 'correction'), 0)::int as returned,
           max(t.created_at) filter (where t.type = 'checkout') as since
    from transactions t join items i on i.id = t.item_id
    where t.holder_id is not null and i.type = 'consumable' and t.custody_delta <> 0 ${to}
    group by t.item_id, t.holder_id having sum(t.custody_delta) > 0
  ),
  iss as (
    select t.item_id, t.holder_id, t.due_at, sum(t.custody_delta) over (partition by t.item_id, t.holder_id order by t.seq) as cum
    from transactions t join items i on i.id = t.item_id
    where t.custody_delta > 0 and t.holder_id is not null and i.type = 'consumable' ${to}
  ),
  out as (
    select i.id as item_id, i.current_holder_id as holder_id, 1 as quantity, 1 as issued, 0 as returned, i.checked_out_at as since, i.due_at, i.current_job_id as job_id
    from items i where i.type = 'asset' and i.asset_state = 'checked_out' ${io}
    union all
    select b.item_id, b.holder_id, b.quantity, b.issued, b.returned, b.since,
           (select s.due_at from iss s where s.item_id = b.item_id and s.holder_id = b.holder_id and s.cum > (b.issued_all - b.quantity) order by s.cum limit 1),
           null::uuid
    from bal b
  )`;
};

export const lowStockWhere = sql`i.type = 'consumable' and i.archived_at is null and coalesce(i.min_quantity, c.default_min_quantity) is not null
  and i.quantity_available <= coalesce(i.min_quantity, c.default_min_quantity)`;

/** Above the minimum but inside the "close to minimum" band. Percent 0 ⇒ never. */
export const nearWhere = (pct: number) => sql`i.type = 'consumable' and i.archived_at is null and ${pct} > 0
  and coalesce(i.min_quantity, c.default_min_quantity) > 0
  and i.quantity_available > coalesce(i.min_quantity, c.default_min_quantity)
  and i.quantity_available <= coalesce(i.min_quantity, c.default_min_quantity) + ceil(coalesce(i.min_quantity, c.default_min_quantity) * ${pct} / 100.0)`;

// ── Pagination for computed views: a stable total order + an opaque offset cursor ─────────────
export const encodeOffset = (n: number) => Buffer.from(`o:${n}`).toString('base64url');
export function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m) throw new ValidationError('Malformed pagination cursor');
  return Number(m[1]);
}

export interface OutstandingFilters { holderId?: string; type?: 'asset' | 'consumable'; overdueOnly?: boolean; q?: string; cursor?: string; limit: number }

export interface OutstandingRow {
  item_id: string; item_number: string; item_name: string; item_type: 'asset' | 'consumable'; unit: string;
  holder_id: string; holder_name: string; holder_kind: string; quantity: number; issued: number; returned: number;
  since: Date | null; due_at: Date | null; job_id: string | null; overdue: boolean;
}

export async function outstandingPage(db: Db, orgId: string, f: OutstandingFilters, now = new Date()) {
  const offset = decodeOffset(f.cursor);
  const where: SQL[] = [sql`true`];
  if (f.holderId) where.push(sql`o.holder_id = ${f.holderId}`);
  if (f.type) where.push(sql`i.type = ${f.type}`);
  if (f.overdueOnly) where.push(sql`o.due_at is not null and o.due_at < ${ts(now)}`);
  if (f.q) where.push(sql`(i.name ilike ${contains(f.q)} or i.item_number ilike ${contains(f.q)} or h.name ilike ${contains(f.q)})`);
  const rows = rowsOf<OutstandingRow>(await db.execute(sql`
    with ${outstandingCte(orgId)}
    select i.id as item_id, i.item_number, i.name as item_name, i.type as item_type, i.unit,
           h.id as holder_id, h.name as holder_name, h.kind as holder_kind, o.quantity, o.issued, o.returned, o.since, o.due_at, o.job_id,
           (o.due_at is not null and o.due_at < ${ts(now)}) as overdue
    from out o join items i on i.id = o.item_id join holders h on h.id = o.holder_id
    where ${sql.join(where, sql` and `)}
    order by (o.due_at is null), o.due_at asc, o.since asc nulls last, o.item_id, o.holder_id
    limit ${f.limit + 1} offset ${offset}`));
  const hasMore = rows.length > f.limit;
  const page = (hasMore ? rows.slice(0, f.limit) : rows).map((r) => ({ ...r, since: toDate(r.since), due_at: toDate(r.due_at) }));
  return { rows: page, nextCursor: hasMore ? encodeOffset(offset + f.limit) : null };
}

export interface LowStockRow {
  item_id: string; item_number: string; item_name: string; unit: string; quantity: number; minimum: number; reorder_quantity: number | null;
  category_name: string | null; location_id: string; status: 'low' | 'near';
}

/** `includeNear` adds the "close to minimum" band after the genuinely-low items. */
export async function lowStockPage(db: Db, orgId: string, f: { cursor?: string; limit: number; q?: string; includeNear?: boolean; nearPct?: number }) {
  const offset = decodeOffset(f.cursor);
  const near = f.includeNear ? nearWhere(f.nearPct ?? 0) : sql`false`;
  const rows = rowsOf<LowStockRow>(await db.execute(sql`
    select i.id as item_id, i.item_number, i.name as item_name, i.unit, i.quantity_available as quantity,
           coalesce(i.min_quantity, c.default_min_quantity) as minimum, i.reorder_quantity, c.name as category_name, i.location_id,
           case when i.quantity_available <= coalesce(i.min_quantity, c.default_min_quantity) then 'low' else 'near' end as status
    from items i left join categories c on c.id = i.category_id
    where i.org_id = ${orgId} and ((${lowStockWhere}) or (${near})) ${f.q ? sql`and (i.name ilike ${contains(f.q)} or i.item_number ilike ${contains(f.q)})` : sql``}
    order by (i.quantity_available > coalesce(i.min_quantity, c.default_min_quantity)), (i.quantity_available - coalesce(i.min_quantity, c.default_min_quantity)) asc, i.name, i.id
    limit ${f.limit + 1} offset ${offset}`));
  const hasMore = rows.length > f.limit;
  return { rows: hasMore ? rows.slice(0, f.limit) : rows, nextCursor: hasMore ? encodeOffset(offset + f.limit) : null };
}

export async function dashboardCounts(db: Db, orgId: string, tz: string, dueSoonHours: number, nearPct: number, now = new Date()) {
  const [r] = rowsOf<Record<string, number>>(await db.execute(sql`
    with ${outstandingCte(orgId)}
    select
      (select count(*)::int from out) as outstanding,
      (select count(*)::int from out where due_at is not null and due_at < ${ts(now)}) as overdue,
      (select count(*)::int from out where due_at is not null and due_at >= ${ts(now)} and due_at < ${ts(now)} + make_interval(hours => ${dueSoonHours})) as due_soon,
      (select count(*)::int from items i left join categories c on c.id = i.category_id where i.org_id = ${orgId} and ${lowStockWhere}) as low_stock,
      (select count(*)::int from items i left join categories c on c.id = i.category_id where i.org_id = ${orgId} and ${nearWhere(nearPct)}) as near_minimum,
      (select count(*)::int from transactions t where t.org_id = ${orgId} and t.type not in ('create','archive','restore','reconciliation')
         and t.created_at >= (date_trunc('day', ${ts(now)} at time zone ${tz}) at time zone ${tz})) as today_transactions,
      (select count(*)::int from items where org_id = ${orgId} and archived_at is null) as active_items`));
  return r;
}

export interface CategoryStats {
  category_id: string; assets: number; products: number; units: number; checked_out: number; under_repair: number; damaged: number; lost: number; low_stock: number; near_minimum: number; overdue: number;
}

/** Per-category rollup for the Collections view. `overdue` reuses the shared outstanding definition, so it always equals the Overdue list. */
export async function categoryStats(db: Db, orgId: string, nearPct: number, now = new Date()): Promise<Map<string, CategoryStats>> {
  const rows = rowsOf<CategoryStats>(await db.execute(sql`
    with ${outstandingCte(orgId)}
    select c.id as category_id,
      count(i.id) filter (where i.type = 'asset')::int as assets,
      count(i.id) filter (where i.type = 'consumable')::int as products,
      coalesce(sum(i.quantity_available) filter (where i.type = 'consumable'), 0)::int as units,
      count(i.id) filter (where i.asset_state = 'checked_out')::int as checked_out,
      count(i.id) filter (where i.asset_state = 'under_repair')::int as under_repair,
      count(i.id) filter (where i.asset_state = 'damaged')::int as damaged,
      count(i.id) filter (where i.asset_state = 'lost')::int as lost,
      count(i.id) filter (where i.type = 'consumable' and coalesce(i.min_quantity, c.default_min_quantity) is not null and i.quantity_available <= coalesce(i.min_quantity, c.default_min_quantity))::int as low_stock,
      count(i.id) filter (where ${nearPct} > 0 and i.type = 'consumable' and coalesce(i.min_quantity, c.default_min_quantity) > 0 and i.quantity_available > coalesce(i.min_quantity, c.default_min_quantity)
                           and i.quantity_available <= coalesce(i.min_quantity, c.default_min_quantity) + ceil(coalesce(i.min_quantity, c.default_min_quantity) * ${nearPct} / 100.0))::int as near_minimum,
      (select count(*)::int from out o join items i2 on i2.id = o.item_id where i2.category_id = c.id and o.due_at is not null and o.due_at < ${ts(now)}) as overdue
    from categories c left join items i on i.category_id = c.id and i.archived_at is null
    where c.org_id = ${orgId} and c.archived_at is null
    group by c.id`));
  return new Map(rows.map((r) => [r.category_id, r]));
}
