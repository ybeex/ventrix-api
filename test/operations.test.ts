import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { ts } from '../src/lib/sql.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkCategory, mkItem, mkHolder, idem, type App, type Session } from './helpers.js';

let app: App;
let admin: Session, sup: Session, staff: Session, viewer: Session;
let john: { id: string }, mary: { id: string };
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app);
  admin = await registerOrg(app);
  sup = await createUser(app, admin, 'supervisor');
  staff = await createUser(app, admin, 'store_staff');
  viewer = await createUser(app, admin, 'viewer');
  john = await mkHolder(app, staff.token, 'John Okafor');
  mary = await mkHolder(app, staff.token, 'Mary Eze');
});

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const tx = (token: string, op: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/transactions/${op}`, body, key);
const get = async (token: string, url: string) => (await call(app, token, 'GET', url)).json();
/** The ledger is immutable by trigger; tests backdate rows by disabling it for one statement (superuser only — the app role cannot). */
async function backdate(sqlText: ReturnType<typeof sql>) {
  await db.execute(sql`alter table transactions disable trigger transactions_immutable`);
  try { await db.execute(sqlText); } finally { await db.execute(sql`alter table transactions enable trigger transactions_immutable`); }
}

test('outstanding = assets out + consumable custody balances; filters; clears on return; always equals the dashboard count', async () => {
  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Makita Drill' });
  const saw = await mkItem(app, admin.token, { type: 'asset', name: 'Circular Saw' });
  const ties = await mkItem(app, admin.token, { type: 'consumable', name: 'Cable ties', openingQuantity: 100 });
  await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id });
  await tx(staff.token, 'checkout', { itemId: saw.id, holderId: mary.id });
  await tx(staff.token, 'checkout', { itemId: ties.id, holderId: john.id, quantity: 30 });
  await tx(staff.token, 'checkout', { itemId: ties.id, holderId: mary.id, quantity: 10 });
  await tx(staff.token, 'checkin', { itemId: ties.id, holderId: john.id, quantity: 5 });

  const all = await get(viewer.token, '/outstanding');
  assert.equal(all.items.length, 4);
  const johnTies = all.items.find((i: any) => i.holder.name === 'John Okafor' && i.item.name === 'Cable ties');
  assert.equal(johnTies.quantity, 25, 'issued 30, returned 5');
  assert.equal(johnTies.dueStatus, null, 'consumables have no due status');
  assert.equal((await get(viewer.token, `/outstanding?holderId=${john.id}`)).items.length, 2);
  assert.equal((await get(viewer.token, '/outstanding?type=asset')).items.length, 2);
  assert.equal((await get(viewer.token, '/outstanding?q=okafor')).items.length, 2, 'search by holder name');
  assert.equal((await get(viewer.token, '/outstanding?q=saw')).items.length, 1);
  assert.equal((await get(viewer.token, '/dashboard')).outstanding, 4, 'dashboard count == list length');

  await tx(staff.token, 'checkin', { itemId: drill.id });
  await tx(staff.token, 'checkin', { itemId: ties.id, holderId: mary.id, quantity: 10 });
  const left = await get(viewer.token, '/outstanding');
  assert.equal(left.items.length, 2);
  assert.equal((await get(viewer.token, '/dashboard')).outstanding, 2);
  assert.deepEqual(await findViolations(db), []);
});

test('overdue: due dates are fixed at issue; overdue list is most-overdue-first; counts match; due-soon window honours the org setting', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Ladders', defaultExpectedReturnHours: 48 });
  const a = await mkItem(app, admin.token, { type: 'asset', name: 'Ladder A', categoryId: cat.id });
  const b = await mkItem(app, admin.token, { type: 'asset', name: 'Ladder B', categoryId: cat.id });
  const c = await mkItem(app, admin.token, { type: 'asset', name: 'No due date' });
  await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id });
  await tx(staff.token, 'checkout', { itemId: b.id, holderId: mary.id });
  await tx(staff.token, 'checkout', { itemId: c.id, holderId: john.id });
  assert.equal((await get(viewer.token, '/overdue')).items.length, 0);
  assert.equal((await get(viewer.token, '/dashboard')).dueSoon, 0, '48h out is outside the 24h window');
  await call(app, admin.token, 'PATCH', '/organization/settings', { dueSoonHours: 72 });
  assert.equal((await get(viewer.token, '/dashboard')).dueSoon, 2, 'org setting widens the window');

  await db.execute(sql`update items set due_at = now() - interval '5 hours' where id = ${a.id}`);
  await db.execute(sql`update items set due_at = now() - interval '30 hours' where id = ${b.id}`);
  const od = await get(viewer.token, '/overdue');
  assert.deepEqual(od.items.map((i: any) => i.item.name), ['Ladder B', 'Ladder A'], 'most overdue first');
  assert.ok(od.items[0].overdueByHours >= 29 && od.items[0].dueStatus === 'overdue');
  const dash = await get(viewer.token, '/dashboard');
  assert.equal(dash.overdue, 2);
  assert.equal(dash.overdue, od.items.length);
  assert.equal((await get(viewer.token, '/outstanding?overdue=true')).items.length, 2);
  assert.equal((await get(viewer.token, '/outstanding')).items.find((i: any) => i.item.name === 'No due date').dueStatus, 'on_time');
  const itemView = await get(viewer.token, `/items/${a.id}`);
  assert.equal(itemView.dueStatus, 'overdue', 'item detail agrees with the overdue list');
  await tx(staff.token, 'checkin', { itemId: a.id });
  assert.equal((await get(viewer.token, '/overdue')).items.length, 1, 'returned items leave the overdue list');
});

test('low stock: item minimum else category default; furthest below first; out-of-stock flag; paginates; equals dashboard', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Fasteners', defaultMinQuantity: 100 });
  await mkItem(app, admin.token, { type: 'consumable', name: 'Bolts', openingQuantity: 90, categoryId: cat.id });
  await mkItem(app, admin.token, { type: 'consumable', name: 'Nuts', openingQuantity: 20, categoryId: cat.id });
  await mkItem(app, admin.token, { type: 'consumable', name: 'Gloves', openingQuantity: 0, minQuantity: 10, reorderQuantity: 200 });
  await mkItem(app, admin.token, { type: 'consumable', name: 'Plenty', openingQuantity: 500, categoryId: cat.id });
  await mkItem(app, admin.token, { type: 'consumable', name: 'Unmonitored', openingQuantity: 0 });
  const r = await get(viewer.token, '/low-stock');
  assert.deepEqual(r.items.map((i: any) => i.item.name), ['Nuts', 'Bolts', 'Gloves'], 'furthest below first (80 short), then ties by name');
  const gloves = r.items.find((i: any) => i.item.name === 'Gloves');
  assert.deepEqual([gloves.outOfStock, gloves.shortfall, gloves.reorderQuantity, gloves.minimum], [true, 10, 200, 10]);
  assert.equal(r.items.find((i: any) => i.item.name === 'Nuts').shortfall, 80);
  assert.equal((await get(viewer.token, '/dashboard')).lowStock, 3);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const p: any = await get(viewer.token, `/low-stock?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...p.items.map((i: any) => i.item.name));
    cursor = p.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);
  assert.equal((await call(app, viewer.token, 'GET', '/low-stock?cursor=garbage')).statusCode, 400);
  await tx(staff.token, 'restock', { itemId: (r.items[0].item.id), quantity: 1000 });
  assert.equal((await get(viewer.token, '/dashboard')).lowStock, 2, 'restocking clears the flag immediately');
});

test("dashboard 'today' is the ORGANIZATION's local day, not UTC; setup rows don't count as activity", async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 100 });
  for (let i = 0; i < 3; i++) await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 });
  assert.equal((await get(viewer.token, '/dashboard')).todayTransactions, 3, 'the opening-balance CREATE row is not an operation');
  const [{ start: startRaw }] = rows(await db.execute(sql`select (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') as start`)) as [{ start: string | Date }];
  const start = new Date(startRaw);
  const ids = rows(await db.execute(sql`select id from transactions where type = 'consume' order by seq`)).map((r) => r.id);
  await backdate(sql`update transactions set created_at = ${ts(new Date(start.getTime() - 60_000))} where id = ${ids[0]}`); // 1 minute before local midnight
  await backdate(sql`update transactions set created_at = ${ts(new Date(start.getTime() + 60_000))} where id = ${ids[1]}`); // 1 minute after
  const lagos = await get(viewer.token, '/dashboard');
  assert.equal(lagos.timezone, 'Africa/Lagos');
  assert.equal(lagos.todayTransactions, 2, 'yesterday-23:59 Lagos is excluded; today-00:01 is included (a UTC day would get this wrong by an hour)');
  await call(app, admin.token, 'PATCH', '/organization', { timezone: 'Pacific/Kiritimati' }); // UTC+14
  assert.equal((await get(viewer.token, '/dashboard')).timezone, 'Pacific/Kiritimati');
});

test('dashboard: approvals and sync counts are role-aware', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -1, reason: 'count_correction' });
  const other = await createUser(app, admin, 'store_staff');
  await tx(other.token, 'adjust', { itemId: cons.id, quantityDelta: -1, reason: 'count_correction' });
  assert.equal((await get(sup.token, '/dashboard')).pendingApprovals, 2);
  assert.equal((await get(staff.token, '/dashboard')).pendingApprovals, 1, 'staff see only their own');
  assert.equal((await get(viewer.token, '/dashboard')).pendingApprovals, 0);
});

test('activity log: reviewers only; filter by event/entity/actor/date; wildcard prefix; paginated by sequence; exports are audited', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 });
  await tx(sup.token, 'restock', { itemId: cons.id, quantity: 5 });
  assert.equal((await call(app, staff.token, 'GET', '/activity')).statusCode, 403);
  assert.equal((await call(app, viewer.token, 'GET', '/activity')).statusCode, 403);

  const all = await get(sup.token, '/activity?limit=100');
  const seqs = all.items.map((e: any) => e.sequence);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), 'newest first by sequence');
  const tx_ = await get(sup.token, '/activity?action=transaction.*&limit=100');
  assert.ok(tx_.items.length >= 3 && tx_.items.every((e: any) => e.action.startsWith('transaction.')));
  assert.deepEqual((await get(sup.token, '/activity?action=transaction.consume')).items.map((e: any) => e.actor.name), ['store_staff person'.replace('store_staff person', 'store_staff person')]);
  assert.equal((await get(sup.token, `/activity?actorId=${sup.userId}&action=transaction.restock`)).items.length, 1);
  assert.equal((await get(sup.token, `/activity?entityType=item&entityId=${cons.id}&limit=100`)).items.length, 3);
  assert.equal((await get(sup.token, '/activity?from=2999-01-01T00:00:00Z')).items.length, 0);
  assert.equal((await call(app, sup.token, 'GET', '/activity?action=DROP TABLE')).statusCode, 400);

  const seen: number[] = [];
  let cursor: string | null = null;
  do { const p: any = await get(sup.token, `/activity?limit=2${cursor ? `&cursor=${cursor}` : ''}`); seen.push(...p.items.map((e: any) => e.sequence)); cursor = p.nextCursor; } while (cursor);
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.length >= all.items.length);

  const csv = await call(app, sup.token, 'GET', '/activity?format=csv&action=transaction.*');
  assert.equal(csv.statusCode, 200);
  assert.match(String(csv.headers['content-type']), /text\/csv/);
  assert.match(csv.body.split('\n')[0], /Time \(UTC\),What happened,Event/);
  const exported = rows(await db.execute(sql`select action, actor_user_id from audit_events where action = 'report.exported'`));
  assert.equal(exported.length, 1);
  assert.equal(exported[0].actor_user_id, sup.userId, 'who pulled the data is on the record');
});

test('reports: reviewers only; JSON == CSV; formula injection neutralised; numbers stay numeric; export is audited', async () => {
  const evil = await mkItem(app, admin.token, { type: 'consumable', name: '=HYPERLINK("http://evil.example","click")', openingQuantity: 5 });
  await mkItem(app, admin.token, { type: 'consumable', name: '+SUM(1+1)', openingQuantity: 2 });
  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Drill' });
  await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id, note: '@cmd|calc' });
  await tx(staff.token, 'adjust', { itemId: evil.id, quantityDelta: -1, reason: 'count_correction' }); // pending for staff; supervisor commits below
  await tx(sup.token, 'adjust', { itemId: evil.id, quantityDelta: -2, reason: 'count_correction' });

  for (const t of [staff, viewer]) assert.equal((await call(app, t.token, 'GET', '/reports')).statusCode, 403);
  assert.equal((await call(app, sup.token, 'GET', '/reports/bogus')).statusCode, 404);
  const list = await get(sup.token, '/reports');
  assert.deepEqual(list.items.map((r: any) => r.name).sort(), ['discrepancies', 'inventory', 'low-stock', 'outstanding', 'transactions']);

  const json = await get(sup.token, '/reports/inventory?limit=100');
  const csv = await call(app, sup.token, 'GET', '/reports/inventory?format=csv');
  const lines = csv.body.trim().split('\n');
  assert.equal(lines.length - 1, json.rows.length, 'CSV and JSON agree on row count');
  assert.ok(csv.body.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), 'leading = is neutralised with an apostrophe');
  assert.ok(csv.body.includes("'+SUM(1+1)"));
  assert.ok(!/^=/m.test(csv.body) && !/,=HYPERLINK/.test(csv.body), 'no cell begins with a formula character');
  const tcsv = await call(app, sup.token, 'GET', '/reports/transactions?format=csv');
  assert.ok(tcsv.body.includes("'@cmd|calc"), 'notes are neutralised too');
  assert.match(tcsv.body, /,-2,/, 'a negative stock change stays a plain number, not quoted text');
  const out = await get(sup.token, '/reports/outstanding');
  assert.deepEqual(out.rows.map((r: any) => [r.holder, r.item, r.overdue]), [['John Okafor', 'Drill', 'no']]);
  const filtered = await get(sup.token, `/reports/transactions?txType=adjustment&from=2000-01-01T00:00:00Z&limit=100`);
  assert.equal(filtered.rows.length, 1);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from audit_events where action = 'report.exported'`))[0].n, 2);
});

test('CSV export streams every page: 1,250 rows cross the 1,000-row page boundary with no gap or duplicate', async () => {
  const [loc] = rows(await db.execute(sql`select id from locations where org_id = ${admin.orgId} limit 1`));
  const [cat] = rows(await db.execute(sql`select id from categories where org_id = ${admin.orgId} limit 1`));
  await db.execute(sql`
    insert into items (org_id, item_number, type, code, name, location_id, category_id, quantity_available, created_by, updated_by)
    select ${admin.orgId}, 'BULK-' || lpad(g::text, 5, '0'), 'consumable', 'BULK-' || lpad(g::text, 5, '0'), 'Bulk item ' || g, ${loc.id}, ${cat.id}, g, ${admin.userId}, ${admin.userId}
    from generate_series(1, 1250) g`);
  const csv = await call(app, sup.token, 'GET', '/reports/inventory?format=csv');
  const lines = csv.body.trim().split('\n');
  assert.equal(lines.length, 1251);
  const ids = lines.slice(1).map((l) => l.split(',')[0]);
  assert.equal(new Set(ids).size, 1250);
  const json = await get(sup.token, '/reports/inventory?limit=500');
  assert.equal(json.rows.length, 500);
  assert.ok(json.nextCursor);
});

test('tenant isolation: outstanding, low-stock, dashboard, activity and reports never include another org', async () => {
  const other = await registerOrg(app, 'Rival');
  const oSup = await createUser(app, other, 'supervisor');
  const oHolder = await mkHolder(app, other.token, 'Their Worker');
  const theirs = await mkItem(app, other.token, { type: 'consumable', name: 'Their stuff', openingQuantity: 1, minQuantity: 5 });
  await tx(other.token, 'checkout', { itemId: theirs.id, holderId: oHolder.id, quantity: 1 }, idem());
  const mine = await mkItem(app, admin.token, { type: 'consumable', name: 'Mine', openingQuantity: 50, minQuantity: 5 });
  await tx(staff.token, 'checkout', { itemId: mine.id, holderId: john.id, quantity: 2 });
  const names = (r: any) => JSON.stringify(r);
  assert.ok(!names(await get(sup.token, '/outstanding')).includes('Their'));
  assert.ok(!names(await get(sup.token, '/low-stock')).includes('Their'));
  assert.ok(!names(await get(sup.token, '/activity?limit=100')).includes('Their'));
  assert.ok(!names(await get(sup.token, '/reports/inventory?limit=100')).includes('Their'));
  assert.ok(!names(await call(app, sup.token, 'GET', '/reports/transactions?format=csv').then((r) => r.body)).includes('Their'));
  assert.equal((await get(sup.token, '/dashboard')).outstanding, 1);
  assert.equal((await get(oSup.token, '/dashboard')).outstanding, 1);
  assert.equal((await get(oSup.token, '/dashboard')).lowStock, 1);
  assert.equal((await get(sup.token, '/dashboard')).lowStock, 0);
});
