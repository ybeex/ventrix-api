/**
 * Load-test seeder (WS5). Builds a large, *internally consistent* dataset so the heavy SQL can be measured at volume and the
 * integrity oracle can be run over it afterwards.
 *
 *   DATABASE_URL=postgres://…/storekeeper_load REDIS_URL=… node --import tsx scripts/seed-load.ts
 *
 * Re-runnable and additive: each run appends SEED_ITEMS more items (numbers continue where the last run stopped), so a large
 * dataset can be built in several short runs.
 *
 * Environment (defaults shown):
 *   SEED_ORG_SLUG=load-big   organization slug (registered through the real API on the first run; the admin is admin@<slug>.test / LOAD_PASSWORD)
 *   SEED_ITEMS=5000          items to add this run (20% assets, 80% consumables)
 *   SEED_CONSUMABLE_EVENTS=60  ledger rows per consumable (create, then consume / checkout / partial check-in / restock cycles)
 *   SEED_ASSET_EVENTS=40     ledger rows per asset (create, then checkout / check-in pairs; odd/even decides the final state)
 *   SEED_SHELVES=20 SEED_CATS_PER_SHELF=10 SEED_HOLDERS=2000   structure (only created on the first run)
 *   SEED_AUDIT_RATIO=4       one audit row per N ledger rows
 *
 * Shape guarantees (what makes `findViolations` pass): quantity_available = Σ stock_delta; balance_before/after chain per item;
 * custody per (item, holder) never negative; asset state/holder agree with the ledger; asset state chain unbroken.
 */
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db } from '../src/db/index.js';
import { runMigrations } from './migrate.js';
import { env } from '../src/env.js';

const num = (k: string, d: number) => Number(process.env[k] ?? d);
const slug = process.env.SEED_ORG_SLUG ?? 'load-big';
const PASSWORD = process.env.LOAD_PASSWORD ?? 'Load-Test-Password-42';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const t0 = Date.now(); const lap = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

await runMigrations(env.DATABASE_URL);
const app = await buildApp(); await app.ready();

// ── 1. organization (through the real API, so defaults/seeding are exactly what production creates) ──
let [org] = rows<{ id: string }>(await db.execute(sql`select id from organizations where slug = ${slug}`));
if (!org) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: slug, email: `admin@${slug}.test`, password: PASSWORD, adminName: 'Load Admin' } });
  if (r.statusCode !== 201) throw new Error(`register-org failed: ${r.statusCode} ${r.body}`);
  [org] = rows<{ id: string }>(await db.execute(sql`select id from organizations where slug = ${slug}`));
  lap(`registered org ${slug}`);
}
const orgId = org.id;
const [{ id: adminId }] = rows<{ id: string }>(await db.execute(sql`select id from users where org_id = ${orgId} order by created_at limit 1`));
const [{ id: locationId }] = rows<{ id: string }>(await db.execute(sql`select id from locations where org_id = ${orgId} order by created_at limit 1`));

// ── 2. structure (first run only): shelves → categories, holders ──
const [{ n: nShelves }] = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from shelves where org_id = ${orgId}`));
if (nShelves <= 1) {
  const S = num('SEED_SHELVES', 20), C = num('SEED_CATS_PER_SHELF', 10), H = num('SEED_HOLDERS', 2000);
  await db.execute(sql`
    with sh as (
      insert into shelves (org_id, location_id, name, code, position)
      select ${orgId}, ${locationId}, 'Load shelf ' || g, 'LSH-' || lpad(g::text, 4, '0'), g from generate_series(1, ${S}::int) g returning id, position)
    insert into categories (org_id, shelf_id, name, code_prefix, default_min_quantity)
    select ${orgId}, sh.id, 'Load category ' || sh.position || '-' || c, null, 50 from sh, generate_series(1, ${C}::int) c`);
  await db.execute(sql`
    insert into holders (org_id, kind, name, created_by)
    select ${orgId}, (array['person','person','person','team','job_site'])[1 + g % 5]::holder_kind, 'Load holder ' || g, ${adminId} from generate_series(1, ${H}::int) g`);
  lap(`structure: ${S} shelves, ${S * C} categories, ${H} holders`);
}

// ── 3. items + ledger + audit (set-based) ──
const N = num('SEED_ITEMS', 5000), EC = Math.max(num('SEED_CONSUMABLE_EVENTS', 60), 2), EA = Math.max(num('SEED_ASSET_EVENTS', 40), 2), AUD = Math.max(num('SEED_AUDIT_RATIO', 4), 1);
const [{ off }] = rows<{ off: number }>(await db.execute(sql`select count(*)::int as off from items where org_id = ${orgId} and item_number like 'LD-%'`));

await db.execute(sql`drop table if exists seed_cat, seed_hold, seed_items, seed_ev`);
await db.execute(sql`create temp table seed_cat as select row_number() over (order by id)::int as rn, id from categories where org_id = ${orgId} and name like 'Load category %'`);
await db.execute(sql`create temp table seed_hold as select row_number() over (order by id)::int as rn, id from holders where org_id = ${orgId} and name like 'Load holder %'`);
const [{ nc, nh }] = rows<{ nc: number; nh: number }>(await db.execute(sql`select (select count(*) from seed_cat)::int as nc, (select count(*) from seed_hold)::int as nh`));

await db.execute(sql`
  create temp table seed_items as
  select gen_random_uuid() as id, g as n, (g % 5 <> 0) as is_cons,
         (select id from seed_cat where rn = 1 + g % ${nc}::int) as category_id,
         (select id from seed_hold where rn = 1 + g % ${nh}::int) as h1,
         (select id from seed_hold where rn = 1 + (g * 7) % ${nh}::int) as h2,
         case when g % 5 <> 0 then ${EC}::int else ${EA}::int + (g % 2) end as n_events
  from generate_series(${off + 1}::int, ${off + N}::int) g`);
lap(`item plan: ${N} items (offset ${off})`);

await db.execute(sql`
  create temp table seed_ev as
  with ev as (
    select i.id as item_id, i.n, i.is_cons, i.h1, i.h2, i.n_events, e,
      case when i.is_cons then (case when e = 1 then 'create' else (array['consume','checkout','checkin','restock'])[1 + (e - 2) % 4] end)
           else (case when e = 1 then 'create' when e % 2 = 0 then 'checkout' else 'checkin' end) end as type
    from seed_items i, lateral generate_series(1, i.n_events) e
  ), fx as (
    select *,
      case when is_cons then (case type when 'create' then 1000 when 'consume' then -3 when 'checkout' then -5 when 'checkin' then 2 else 10 end) else 0 end as stock_delta,
      case type when 'checkout' then (case when is_cons then 5 else 1 end) when 'checkin' then (case when is_cons then -2 else -1 end) else 0 end as custody_delta
    from ev
  )
  select gen_random_uuid() as tid, item_id, n, is_cons, n_events, e, type, stock_delta, custody_delta,
    case when type in ('checkout','checkin') then h1 when type = 'consume' then h2 end as holder_id,
    case when is_cons then sum(stock_delta) over w - stock_delta end as balance_before,
    case when is_cons then sum(stock_delta) over w end as balance_after,
    case when not is_cons then (case type when 'create' then null when 'checkout' then 'available' else 'checked_out' end) end as state_before,
    case when not is_cons then (case type when 'checkin' then 'available' when 'create' then 'available' else 'checked_out' end) end as state_after,
    case when type = 'create' then (case when is_cons then 1000 end) when type = 'restock' then 10 when type = 'consume' then 3 when type = 'checkout' then (case when is_cons then 5 else 1 end) when type = 'checkin' then (case when is_cons then 2 else 1 end) end as quantity,
    now() - interval '120 days' + (e::float / n_events) * interval '120 days' + (n % 1000) * interval '1 second' as at
  from fx window w as (partition by item_id order by e)`);
lap('events computed');

await db.execute(sql`
  insert into items (id, org_id, item_number, type, code, name, category_id, location_id, asset_state, current_holder_id, checked_out_at, due_at, quantity_available, min_quantity, created_by, updated_by, created_at, updated_at)
  select i.id, ${orgId}, 'LD-' || lpad(i.n::text, 7, '0'), (case when i.is_cons then 'consumable' else 'asset' end)::item_type, 'LD-' || lpad(i.n::text, 7, '0'),
         (array['Cable ties','Anchor bolts','Welding rod','Drill bit','Angle grinder','Safety harness','Extension reel','Cement bag'])[1 + i.n % 8] || ' ' || i.n,
         i.category_id, ${locationId},
         case when not i.is_cons then (case when i.n_events % 2 = 0 then 'checked_out' else 'available' end)::asset_state end,
         case when not i.is_cons and i.n_events % 2 = 0 then i.h1 end,
         case when not i.is_cons and i.n_events % 2 = 0 then now() - interval '3 days' end,
         case when not i.is_cons and i.n_events % 2 = 0 then (case when i.n % 3 = 0 then now() - interval '1 day' else now() + interval '2 days' end) end,
         case when i.is_cons then (select sum(stock_delta) from seed_ev v where v.item_id = i.id)::int end,
         case when i.is_cons then 200 end, ${adminId}, ${adminId}, now() - interval '121 days', now()
  from seed_items i`);
lap('items inserted');

await db.execute(sql`
  insert into transactions (id, org_id, type, item_id, quantity, stock_delta, custody_delta, balance_before, balance_after, state_before, state_after, actor_user_id, holder_id, location_id, due_at, occurred_at, created_at)
  select tid, ${orgId}, type::transaction_type, item_id, quantity, stock_delta, custody_delta, balance_before, balance_after, state_before::asset_state, state_after::asset_state,
         ${adminId}, holder_id, ${locationId},
         case when type = 'checkout' then (case when n % 3 = 0 then at - interval '10 days' else at + interval '3 days' end) end, at, at
  from seed_ev order by item_id, e`);
lap('ledger inserted');

await db.execute(sql`
  insert into audit_events (org_id, actor_user_id, action, entity_type, entity_id, next, transaction_id, created_at)
  select ${orgId}, ${adminId}, 'transaction.' || type, 'item', item_id::text, jsonb_build_object('quantity', quantity), tid, at from seed_ev where e % ${AUD}::int = 0 order by at`);
lap('audit inserted');

// A few thousand "other" audit rows so activity filters have variety.
await db.execute(sql`
  insert into audit_events (org_id, actor_user_id, action, entity_type, entity_id, next, created_at)
  select ${orgId}, ${adminId}, (array['item.updated','holder.updated','shelf.updated','access.denied','auth.login'])[1 + g % 5], 'item', i.id::text, '{}'::jsonb, now() - (g % 100) * interval '1 hour'
  from generate_series(1, ${Math.min(N, 5000)}::int) g join lateral (select id from seed_items offset (g % ${N}::int) limit 1) i on true`);

await db.execute(sql`analyze items`); await db.execute(sql`analyze transactions`); await db.execute(sql`analyze audit_events`); await db.execute(sql`analyze holders`);
const [c] = rows<Record<string, number>>(await db.execute(sql`select (select count(*) from items where org_id = ${orgId})::int items, (select count(*) from transactions where org_id = ${orgId})::int ledger, (select count(*) from audit_events where org_id = ${orgId})::int audit, (select count(*) from holders where org_id = ${orgId})::int holders`));
lap(`done: ${JSON.stringify(c)}  login: admin@${slug}.test / ${PASSWORD}  slug: ${slug}`);
await app.close(); process.exit(0);
