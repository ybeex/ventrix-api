/** WS1 §8: near-minimum band, partial return, consumable due dates (FIFO), and cross-view consistency (list == dashboard == collections). */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { scanOverdue, processDomainEvents } from '../src/modules/notifications/service.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkCategory, mkItem, mkHolder, idem, seededCatalog, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session, viewer: Session; let john: { id: string }, mary: { id: string };
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app); admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff'); viewer = await createUser(app, admin, 'viewer');
  john = await mkHolder(app, staff.token, 'John Okafor'); mary = await mkHolder(app, staff.token, 'Mary Eze');
});

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const get = async (token: string, url: string) => (await call(app, token, 'GET', url)).json();
const tx = (token: string, op: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/transactions/${op}`, body, key);
const HOUR = 3_600_000; const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const setPct = (n: number) => call(app, admin.token, 'PATCH', '/organization/settings', { nearMinimumPercent: n });
async function backdate(sqlText: ReturnType<typeof sql>) {
  await db.execute(sql`alter table transactions disable trigger transactions_immutable`);
  try { await db.execute(sqlText); } finally { await db.execute(sql`alter table transactions enable trigger transactions_immutable`); }
}
const integrity = async () => assert.deepEqual(await findViolations(db), []);

// ── near-minimum ─────────────────────────────────────────────────────────────
const stock = async (name: string, qty: number, min: number | null, extra: Record<string, unknown> = {}) =>
  mkItem(app, admin.token, { type: 'consumable', name, openingQuantity: qty, ...(min === null ? {} : { minQuantity: min }), ...extra });
const flags = async (id: string) => { const v = await get(admin.token, `/items/${id}`); return { low: v.lowStock, near: v.nearMinimum }; };

test('near-minimum boundaries (10%): qty == min is LOW not near; min+ceil(10%) is near; one above is neither', async () => {
  const a = await stock('min10', 10, 10); // band: 11
  const b = await stock('min10-at11', 11, 10); const c = await stock('min10-at12', 12, 10);
  assert.deepEqual(await flags(a.id), { low: true, near: false });
  assert.deepEqual(await flags(b.id), { low: false, near: true });
  assert.deepEqual(await flags(c.id), { low: false, near: false });
  const d = await stock('min15', 16, 15); const e = await stock('min15-at17', 17, 15); const f = await stock('min15-at18', 18, 15); // ceil(1.5)=2 → band up to 17
  assert.deepEqual([await flags(d.id), await flags(e.id), await flags(f.id)], [{ low: false, near: true }, { low: false, near: true }, { low: false, near: false }]);
});

test('percent 0 disables the band everywhere: item flag, low-stock list, dashboard, collections', async () => {
  await setPct(0); const it = await stock('x', 11, 10);
  assert.deepEqual(await flags(it.id), { low: false, near: false });
  assert.equal((await get(admin.token, '/low-stock?includeNear=true')).items.length, 0);
  assert.equal((await get(admin.token, '/dashboard')).nearMinimum, 0);
  assert.equal((await get(admin.token, '/collections')).shelves[0].stats.nearMinimum, 0);
});

test('changing the percent takes effect immediately (settings cache is invalidated)', async () => {
  const it = await stock('x', 13, 10);
  assert.equal((await flags(it.id)).near, false); assert.equal((await setPct(30)).statusCode, 200);
  assert.equal((await flags(it.id)).near, true, '30% of 10 = 3 → 13 is inside');
  assert.equal((await get(admin.token, '/dashboard')).nearMinimum, 1);
  await setPct(10); assert.equal((await flags(it.id)).near, false);
  assert.equal((await call(app, admin.token, 'PATCH', '/organization/settings', { nearMinimumPercent: 101 })).statusCode, 400);
  assert.equal((await call(app, admin.token, 'PATCH', '/organization/settings', { nearMinimumPercent: -1 })).statusCode, 400);
});

test('minimum zero or unset is never "near"; the category default minimum is honoured; assets are never near', async () => {
  const zero = await stock('zero-min', 1, 0); const none = await stock('no-min', 1, null);
  const cat = await mkCategory(app, admin.token, { name: 'Defaults', defaultMinQuantity: 20 });
  const inherits = await mkItem(app, admin.token, { type: 'consumable', name: 'inherits', categoryId: cat.id, openingQuantity: 22 });
  const asset = await mkItem(app, admin.token, { type: 'asset', name: 'drill' });
  assert.deepEqual(await flags(zero.id), { low: false, near: false }); assert.deepEqual(await flags(none.id), { low: false, near: false });
  assert.deepEqual(await flags(inherits.id), { low: false, near: true }, '20 + ceil(2) = 22');
  assert.deepEqual(await flags(asset.id), { low: false, near: false });
});

test('archived items drop out of near and low counts', async () => {
  const it = await stock('x', 11, 10); assert.equal((await get(admin.token, '/dashboard')).nearMinimum, 1);
  await callIdem(app, admin.token, 'POST', `/items/${it.id}/archive`, {});
  assert.equal((await get(admin.token, '/dashboard')).nearMinimum, 0); assert.equal((await get(admin.token, '/low-stock?includeNear=true')).items.length, 0);
});

test('low-stock list: near items only with includeNear, low before near, headroom/shortfall/status; dashboard + collections counts equal the list', async () => {
  await stock('low-a', 2, 10); await stock('low-b', 9, 10); await stock('near-a', 11, 10); await stock('near-b', 12, 11); await stock('fine', 100, 10);
  const lowOnly = await get(admin.token, '/low-stock'); assert.deepEqual(lowOnly.items.map((i: any) => i.item.name).sort(), ['low-a', 'low-b']);
  const all = (await get(admin.token, '/low-stock?includeNear=true&limit=100')).items as any[];
  assert.deepEqual(all.map((i) => i.status), ['low', 'low', 'near', 'near'], 'every low item precedes every near item');
  const nearA = all.find((i) => i.item.name === 'near-a'); assert.deepEqual([nearA.headroom, nearA.shortfall, nearA.status], [1, 0, 'near']);
  const lowA = all.find((i) => i.item.name === 'low-a'); assert.deepEqual([lowA.shortfall, lowA.headroom, lowA.outOfStock], [8, 0, false]);
  const dash = await get(admin.token, '/dashboard'); assert.equal(dash.lowStock, 2); assert.equal(dash.nearMinimum, 2);
  const col = (await get(admin.token, '/collections')).shelves[0].stats; assert.equal(col.lowStock, 2); assert.equal(col.nearMinimum, 2);
  const page1 = await get(admin.token, '/low-stock?includeNear=true&limit=3'); const page2 = await get(admin.token, `/low-stock?includeNear=true&limit=3&cursor=${page1.nextCursor}`);
  assert.equal(page1.items.length + page2.items.length, 4); assert.equal(page2.nextCursor, null);
  assert.equal((await get(admin.token, '/low-stock?includeNear=true&q=near-a')).items.length, 1);
});

test('crossing from near to low and back is reflected in every view (consume / restock)', async () => {
  const it = await stock('x', 12, 10); assert.equal((await flags(it.id)).near, false);
  await tx(staff.token, 'consume', { itemId: it.id, quantity: 1 }); assert.deepEqual(await flags(it.id), { low: false, near: true });
  await tx(staff.token, 'consume', { itemId: it.id, quantity: 1 }); assert.deepEqual(await flags(it.id), { low: true, near: false });
  assert.deepEqual([(await get(admin.token, '/dashboard')).lowStock, (await get(admin.token, '/dashboard')).nearMinimum], [1, 0]);
  await tx(sup.token, 'restock', { itemId: it.id, quantity: 1 }); assert.deepEqual(await flags(it.id), { low: false, near: true });
});

// ── partial return + consumable due dates (FIFO) ─────────────────────────────
const line = async (itemId: string, holderId: string) => ((await get(viewer.token, `/outstanding?holderId=${holderId}&limit=100`)).items as any[]).find((i) => i.item.id === itemId);
const issue = async (itemId: string, holderId: string, quantity: number, dueAt?: string) => { const r = await tx(staff.token, 'checkout', { itemId, holderId, quantity, ...(dueAt ? { dueAt } : {}) }); assert.equal(r.statusCode, 201, r.body); return r.json().transaction.id as string; };
const back = async (itemId: string, holderId: string, quantity: number) => { const r = await tx(staff.token, 'checkin', { itemId, holderId, quantity }); assert.equal(r.statusCode, 201, r.body); };
const D1 = () => iso(2 * 24 * HOUR), D2 = () => iso(5 * 24 * HOUR);

test('(a) one issue, partial return: quantities, partialReturn flag, and the due date is unchanged', async () => {
  const it = await stock('ties', 100, null); const d1 = D1(); await issue(it.id, john.id, 10, d1);
  let l = await line(it.id, john.id); assert.deepEqual([l.quantity, l.issuedQuantity, l.returnedQuantity, l.partialReturn], [10, 10, 0, false]); assert.equal(l.dueAt, d1);
  await back(it.id, john.id, 4);
  l = await line(it.id, john.id); assert.deepEqual([l.quantity, l.issuedQuantity, l.returnedQuantity, l.partialReturn], [6, 10, 4, true]); assert.equal(l.dueAt, d1); assert.equal(l.dueStatus, 'on_time');
  await back(it.id, john.id, 6); assert.equal(await line(it.id, john.id), undefined, 'fully returned → off the list');
  await integrity();
});

test('(b) two issues with different dues; a return that exactly covers the first makes the second’s due the line’s due', async () => {
  const it = await stock('ties', 100, null); const d1 = D1(), d2 = D2();
  await issue(it.id, john.id, 10, d1); await issue(it.id, john.id, 5, d2);
  let l = await line(it.id, john.id); assert.deepEqual([l.quantity, l.issuedQuantity], [15, 15]); assert.equal(l.dueAt, d1, 'earliest unreturned issue');
  await back(it.id, john.id, 9); l = await line(it.id, john.id); assert.equal(l.dueAt, d1, '9 of the first 10 returned: first issue still has 1 outstanding');
  await back(it.id, john.id, 1); l = await line(it.id, john.id); assert.deepEqual([l.quantity, l.returnedQuantity], [5, 10]); assert.equal(l.dueAt, d2);
});

test('(c) a return larger than the first issue spills into the second', async () => {
  const it = await stock('ties', 100, null); const d1 = D1(), d2 = D2();
  await issue(it.id, john.id, 10, d1); await issue(it.id, john.id, 5, d2);
  await back(it.id, john.id, 12); const l = await line(it.id, john.id);
  assert.deepEqual([l.quantity, l.issuedQuantity, l.returnedQuantity, l.partialReturn], [3, 15, 12, true]); assert.equal(l.dueAt, d2);
  await back(it.id, john.id, 3); assert.equal(await line(it.id, john.id), undefined);
});

test('an issue without a due date does not hide a later one: the line takes the earliest due among unreturned issues that HAVE one only if the oldest has one', async () => {
  const it = await stock('ties', 100, null); await issue(it.id, john.id, 5); await issue(it.id, john.id, 5, D2());
  assert.equal((await line(it.id, john.id)).dueAt, null, 'FIFO: the oldest unreturned issue has no due date');
  assert.equal((await line(it.id, john.id)).dueStatus, null);
  await back(it.id, john.id, 5); assert.equal((await line(it.id, john.id)).dueStatus, 'on_time', 'now the dated issue is the oldest');
});

test('(d) correcting an issue: reversing the first issue moves the due to the second; reversing the second leaves the first', async () => {
  const it = await stock('ties', 100, null); const d1 = D1(), d2 = D2();
  const t1 = await issue(it.id, john.id, 10, d1); const t2 = await issue(it.id, john.id, 5, d2);
  assert.equal((await tx(admin.token, `${t2}/correct`, { note: 'second issue was a mistake' })).statusCode, 201);
  let l = await line(it.id, john.id); assert.deepEqual([l.quantity, l.dueAt], [10, d1]);
  assert.equal((await tx(admin.token, `${t1}/correct`, { note: 'and the first too' })).statusCode, 201);
  assert.equal(await line(it.id, john.id), undefined);
  const x = await stock('ties2', 100, null); const a = await issue(x.id, mary.id, 10, d1); await issue(x.id, mary.id, 5, d2);
  assert.equal((await tx(admin.token, `${a}/correct`, { note: 'wrong person' })).statusCode, 201);
  l = await line(x.id, mary.id); assert.deepEqual([l.quantity, l.dueAt], [5, d2]);
  assert.equal(l.returnedQuantity, 0, 'a correction is not a return');
  await integrity();
});

test('holders are independent: the same item issued to two people has two lines with their own FIFO', async () => {
  const it = await stock('ties', 100, null); const d1 = D1(), d2 = D2();
  await issue(it.id, john.id, 10, d1); await issue(it.id, mary.id, 10, d2); await back(it.id, john.id, 10);
  assert.equal(await line(it.id, john.id), undefined); assert.equal((await line(it.id, mary.id)).dueAt, d2);
});

test('overdue: list == dashboard == collections for consumable lines, and the overdue clock follows FIFO', async () => {
  const it = await stock('ties', 100, null); const asset = await mkItem(app, admin.token, { type: 'asset', name: 'Saw' });
  const t1 = await issue(it.id, john.id, 10, D1()); await issue(it.id, john.id, 5, D2());
  await tx(staff.token, 'checkout', { itemId: asset.id, holderId: mary.id, dueAt: D1() });
  await backdate(sql`update transactions set due_at = now() - interval '3 hours' where id = ${t1}`);
  await db.execute(sql`update items set due_at = now() - interval '2 hours' where id = ${asset.id}`);
  const check = async (n: number) => {
    const list = await get(viewer.token, '/overdue?limit=100'); assert.equal(list.items.length, n);
    const dash = await get(viewer.token, '/dashboard'); assert.equal(dash.overdue, n);
    assert.equal((await get(viewer.token, '/collections')).shelves.reduce((a: number, s: any) => a + s.stats.overdue, 0), n);
    assert.equal((await get(viewer.token, '/outstanding?limit=100')).items.filter((i: any) => i.dueStatus === 'overdue').length, n);
  };
  await check(2);
  const o = (await get(viewer.token, '/overdue?limit=100')).items.find((i: any) => i.item.id === it.id); assert.equal(o.dueStatus, 'overdue'); assert.ok(o.overdueByHours >= 2);
  await back(it.id, john.id, 10); await check(1);
  assert.equal((await get(viewer.token, '/overdue?limit=100')).items[0].item.name, 'Saw');
});

test('scanOverdue: consumable lines are scanned; once per episode; a different holder is a different event; FIFO shift opens a new episode', async () => {
  const it = await stock('ties', 100, null); const t1 = await issue(it.id, john.id, 10, D1()); const t2 = await issue(it.id, john.id, 5, D2()); const t3 = await issue(it.id, mary.id, 4, D1());
  await backdate(sql`update transactions set due_at = now() - interval '3 hours' where id in (${t1}, ${t3})`);
  assert.equal(await scanOverdue(db), 2, 'john and mary each have an overdue line'); assert.equal(await scanOverdue(db), 0, 'same episode → no new events');
  await backdate(sql`update transactions set due_at = now() - interval '1 hours' where id = ${t2}`);
  await back(it.id, john.id, 10); // first issue fully returned → the line's due becomes t2's (also past)
  assert.equal(await scanOverdue(db), 1, 'a new due instant for john is a new episode'); assert.equal(await scanOverdue(db), 0);
  const keys = rows(await db.execute(sql`select dedupe_key from domain_events where type = 'asset.overdue'`)).map((r) => r.dedupe_key as string);
  assert.equal(keys.length, 3); assert.equal(new Set(keys).size, 3);
  assert.equal(keys.filter((k) => k.includes(john.id)).length, 2); assert.equal(keys.filter((k) => k.includes(mary.id)).length, 1);
  await processDomainEvents(db);
  const n = ((await get(admin.token, '/notifications?limit=100')).items as any[]).filter((x) => x.type === 'overdue_checkout'); assert.equal(n.length, 3);
  await integrity();
});

test('scanOverdue still covers assets and is per-asset-per-due-instant', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset', name: 'Saw' }); await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id, dueAt: D1() });
  await db.execute(sql`update items set due_at = now() - interval '1 hour' where id = ${a.id}`);
  assert.equal(await scanOverdue(db), 1); assert.equal(await scanOverdue(db), 0);
});

test('multi-tenant: another org’s consumable lines never leak into this org’s outstanding / overdue / dashboard', async () => {
  const rival = await registerOrg(app, 'Rival'); const rh = await mkHolder(app, rival.token, 'R. Holder');
  const ri = await mkItem(app, rival.token, { type: 'consumable', name: 'Rival ties', openingQuantity: 50 });
  const t = await callIdem(app, rival.token, 'POST', '/transactions/checkout', { itemId: ri.id, holderId: rh.id, quantity: 5, dueAt: D1() }); const id = t.json().transaction.id;
  await backdate(sql`update transactions set due_at = now() - interval '1 hour' where id = ${id}`);
  assert.equal((await get(admin.token, '/outstanding')).items.length, 0); assert.equal((await get(admin.token, '/overdue')).items.length, 0);
  assert.deepEqual([(await get(admin.token, '/dashboard')).outstanding, (await get(admin.token, '/dashboard')).overdue], [0, 0]);
  assert.equal((await get(rival.token, '/dashboard')).overdue, 1);
});
