/**
 * EXPLAIN (ANALYZE, BUFFERS) the heavy statements behind the dashboard, outstanding list and Collections, using the SAME
 * outstandingCte the app uses.   node --import tsx scripts/explain-heavy.ts [dashboard|outstanding|categories|lowstock|all]
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { outstandingCte, lowStockWhere } from '../src/modules/operations/queries.js';

const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const [{ id: orgId }] = rows<{ id: string }>(await db.execute(sql`select id from organizations where slug = ${process.env.SEED_ORG_SLUG ?? 'load-big'}`));
const now = new Date().toISOString();
const run = async (name: string, q: ReturnType<typeof sql>) => {
  const t = Date.now();
  const out = rows<Record<string, string>>(await db.execute(sql`explain (analyze, buffers, costs off) ${q}`)).map((r) => r['QUERY PLAN']);
  console.log(`\n=== ${name} (${Date.now() - t} ms wall)\n${out.join('\n')}`);
};
const which = process.argv[2] ?? 'all';

if (which === 'all' || which === 'dashboard') await run('dashboard (out CTE + counts)', sql`
  with ${outstandingCte(orgId)}
  select (select count(*)::int from out) as outstanding, (select count(*)::int from out where due_at is not null and due_at < ${now}::timestamptz) as overdue`);
if (which === 'all' || which === 'outstanding') await run('outstanding page (limit 50)', sql`
  with ${outstandingCte(orgId)}
  select i.id, i.name, h.name, o.quantity, o.due_at from out o join items i on i.id = o.item_id join holders h on h.id = o.holder_id
  order by (o.due_at is null), o.due_at asc, o.since asc nulls last, o.item_id, o.holder_id limit 51 offset 0`);
if (which === 'all' || which === 'categories') await run('collections: per-category overdue subquery', sql`
  with ${outstandingCte(orgId)}
  select c.id, (select count(*)::int from out o join items i2 on i2.id = o.item_id where i2.category_id = c.id and o.due_at is not null and o.due_at < ${now}::timestamptz) as overdue
  from categories c where c.org_id = ${orgId} and c.archived_at is null`);
if (which === 'all' || which === 'lowstock') await run('low-stock page', sql`
  select i.id, i.name, i.quantity_available from items i left join categories c on c.id = i.category_id
  where i.org_id = ${orgId} and ${lowStockWhere} order by i.quantity_available limit 51`);
process.exit(0);
