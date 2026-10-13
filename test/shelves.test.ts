import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkShelf, mkCategory, mkItem, mkHolder, seededCatalog, multipart, idem, type App, type Session } from './helpers.js';

let app: App;
let admin: Session, sup: Session, staff: Session, viewer: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app);
  admin = await registerOrg(app);
  sup = await createUser(app, admin, 'supervisor');
  staff = await createUser(app, admin, 'store_staff');
  viewer = await createUser(app, admin, 'viewer');
});

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const get = async (token: string, url: string) => (await call(app, token, 'GET', url)).json();
const tx = (token: string, op: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/transactions/${op}`, body, key);
const item = (id: string, token = admin.token) => get(token, `/items/${id}`);
/** MAX_LOCATIONS_PER_ORG=1 stops the API creating a second store, so tests add one directly. */
const secondLocation = async (orgId = admin.orgId) => rows(await db.execute(sql`insert into locations (org_id, name, kind) values (${orgId}, 'Yard store', 'store') returning id`))[0].id as string;

test('a new organization starts with a Main shelf and a General category; shelves and categories are read by everyone, managed by admins', async () => {
  const shelves = (await get(viewer.token, '/shelves')).items;
  assert.deepEqual(shelves.map((s: any) => [s.name, s.code, s.categoryCount, s.itemCount]), [['Main shelf', 'SHF-0001', 1, 0]]);
  const cats = (await get(viewer.token, '/categories')).items;
  assert.deepEqual(cats.map((c: any) => [c.name, c.shelfName]), [['General', 'Main shelf']]);
  for (const t of [sup, staff, viewer]) {
    assert.equal((await call(app, t.token, 'POST', '/shelves', { name: 'Nope' })).statusCode, 403);
    assert.equal((await call(app, t.token, 'POST', '/categories', { shelfId: shelves[0].id, name: 'Nope' })).statusCode, 403);
  }
  assert.equal((await call(app, null, 'GET', '/shelves')).statusCode, 401);
});

test('shelves are created separately (an empty shelf is fine); codes are auto-numbered, unique and scannable', async () => {
  const a = await mkShelf(app, admin.token, { name: 'Power tools rack', description: 'Bay 1' });
  const b = await mkShelf(app, admin.token, { name: 'Consumables' });
  assert.deepEqual([a.code, b.code, a.categoryCount, a.itemCount], ['SHF-0002', 'SHF-0003', 0, 0]);
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'power TOOLS rack' })).json().error.code, 'SHELF_NAME_TAKEN', 'case-insensitive');
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Custom', code: 'SHF-0002' })).json().error.code, 'SHELF_CODE_TAKEN');
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Bad', code: 'has space' })).statusCode, 400);
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Custom', code: 'RACK-A', bogus: 1 })).statusCode, 400);
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Custom', code: 'RACK-A' })).statusCode, 201);
  assert.equal((await get(staff.token, `/shelves/lookup?code=${a.code.toLowerCase()}`)).id, a.id, 'scan resolves a shelf, case-insensitively');
  assert.equal((await call(app, staff.token, 'GET', '/shelves/lookup?code=NOPE')).statusCode, 404);
  assert.match((await call(app, staff.token, 'GET', `/shelves/${a.id}/qr`)).body, /^<svg/);
  assert.equal((await call(app, staff.token, 'GET', `/shelves/${a.id}/qr?format=png`)).rawPayload.subarray(1, 4).toString(), 'PNG');
  const patched = await call(app, admin.token, 'PATCH', `/shelves/${a.id}`, { cycleCountDays: 30, position: 5, description: null });
  assert.deepEqual([patched.json().cycleCountDays, patched.json().position, patched.json().description], [30, 5, null]);
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Elsewhere', locationId: crypto.randomUUID() })).json().error.code, 'LOCATION_NOT_FOUND');
});

test('a category must sit on an existing shelf; one shelf holds many categories; categories filter by shelf', async () => {
  const rack = await mkShelf(app, admin.token, { name: 'Rack' });
  const bin = await mkShelf(app, admin.token, { name: 'Bin wall' });
  assert.equal((await call(app, admin.token, 'POST', '/categories', { name: 'Orphan' })).statusCode, 400, 'shelfId is required');
  assert.equal((await call(app, admin.token, 'POST', '/categories', { shelfId: crypto.randomUUID(), name: 'Ghost' })).json().error.code, 'SHELF_NOT_FOUND');
  const other = await registerOrg(app, 'Rival');
  const theirShelf = (await get(other.token, '/shelves')).items[0];
  assert.equal((await call(app, admin.token, 'POST', '/categories', { shelfId: theirShelf.id, name: 'Cross-tenant' })).json().error.code, 'SHELF_NOT_FOUND');
  for (const n of ['Drills', 'Saws', 'Ladders']) await mkCategory(app, admin.token, { shelfId: rack.id, name: n });
  await mkCategory(app, admin.token, { shelfId: bin.id, name: 'Bolts' });
  assert.deepEqual((await get(admin.token, `/categories?shelfId=${rack.id}`)).items.map((c: any) => c.name).sort(), ['Drills', 'Ladders', 'Saws']);
  assert.deepEqual((await get(admin.token, `/categories?shelfId=${bin.id}`)).items.map((c: any) => c.name), ['Bolts']);
  assert.equal((await get(admin.token, `/shelves/${rack.id}`)).categoryCount, 3);
  assert.equal((await call(app, admin.token, 'PATCH', `/categories/${(await get(admin.token, `/categories?shelfId=${bin.id}`)).items[0].id}`, { shelfId: rack.id })).statusCode, 400, 'the shelf changes only through /move');
});

test('every item must sit in a category; its location is DERIVED from the shelf and never accepted as input', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Drills', codePrefix: 'DRL' });
  assert.equal((await callIdem(app, admin.token, 'POST', '/items', { type: 'asset', name: 'No category' })).statusCode, 400);
  assert.equal((await callIdem(app, admin.token, 'POST', '/items', { type: 'asset', name: 'x', categoryId: crypto.randomUUID() })).json().error.code, 'CATEGORY_NOT_FOUND');
  const other = await registerOrg(app, 'Rival');
  const theirCat = (await get(other.token, '/categories')).items[0];
  assert.equal((await callIdem(app, admin.token, 'POST', '/items', { type: 'asset', name: 'x', categoryId: theirCat.id })).json().error.code, 'CATEGORY_NOT_FOUND');
  assert.equal((await callIdem(app, admin.token, 'POST', '/items', { type: 'asset', name: 'x', categoryId: cat.id, locationId: crypto.randomUUID() })).statusCode, 400);
  assert.equal((await call(app, admin.token, 'PATCH', '/items/' + crypto.randomUUID(), { categoryId: cat.id })).statusCode, 400, 'PATCH cannot re-parent an item either');

  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Makita', categoryId: cat.id });
  const shelf = (await get(admin.token, `/categories/${cat.id}`)).shelfId;
  const loc = (await get(admin.token, `/shelves/${shelf}`)).locationId;
  assert.deepEqual([drill.categoryId, drill.categoryName, drill.shelfId, drill.shelfName, drill.locationId, drill.itemNumber], [cat.id, 'Drills', shelf, 'Main shelf', loc, 'DRL-0001']);
  assert.equal((await get(admin.token, `/items?shelfId=${shelf}`)).items.length, 1);
  assert.equal((await get(admin.token, `/items?q=${encodeURIComponent('main shelf')}`)).items.length, 1, 'search reaches the shelf name');
  assert.equal((await get(admin.token, `/items?shelfId=${crypto.randomUUID()}`)).items.length, 0);
});

test('moving a category re-derives its items\' location in the same transaction; devices see it in the delta; it is audited', async () => {
  const yard = await secondLocation();
  const rack = await mkShelf(app, admin.token, { name: 'Rack' });
  const yardShelf = (await call(app, admin.token, 'PATCH', `/shelves/${(await mkShelf(app, admin.token, { name: 'Yard shelf' })).id}`, { locationId: yard })).json();
  assert.equal(yardShelf.locationId, yard);
  const cat = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'Ladders' });
  const a = await mkItem(app, admin.token, { type: 'asset', categoryId: cat.id });
  const b = await mkItem(app, admin.token, { type: 'consumable', categoryId: cat.id, openingQuantity: 3 });
  const before = (await get(viewer.token, '/sync/snapshot/items')).cursor;
  await new Promise((r) => setTimeout(r, 20));

  const moved = await call(app, admin.token, 'POST', `/categories/${cat.id}/move`, { shelfId: yardShelf.id });
  assert.deepEqual([moved.statusCode, moved.json().itemsRelocated, moved.json().category.shelfId], [200, 2, yardShelf.id]);
  for (const id of [a.id, b.id]) assert.equal((await item(id)).locationId, yard, 'location follows the shelf');
  const delta = await get(viewer.token, `/sync/snapshot/items?cursor=${encodeURIComponent(before)}`);
  assert.deepEqual(delta.items.map((i: any) => i.id).sort(), [a.id, b.id].sort(), 'offline devices receive the moved items');
  const [ev] = rows(await db.execute(sql`select previous, next from audit_events where action = 'category.moved'`));
  assert.deepEqual([ev.previous.shelfId, ev.next.shelfId, ev.next.itemsRelocated], [rack.id, yardShelf.id, 2]);
  assert.equal((await call(app, admin.token, 'POST', `/categories/${cat.id}/move`, { shelfId: yardShelf.id })).json().itemsRelocated, 0, 'moving to where it already is is a no-op');
  assert.equal((await call(app, sup.token, 'POST', `/categories/${cat.id}/move`, { shelfId: rack.id })).statusCode, 403);
  assert.equal((await call(app, admin.token, 'POST', `/categories/${cat.id}/move`, { shelfId: crypto.randomUUID() })).json().error.code, 'SHELF_NOT_FOUND');

  // moving a whole shelf to another location carries every item beneath it
  await call(app, admin.token, 'PATCH', `/shelves/${yardShelf.id}`, { locationId: (await get(admin.token, `/shelves/${rack.id}`)).locationId });
  for (const id of [a.id, b.id]) assert.notEqual((await item(id)).locationId, yard);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from items i join categories c on c.id = i.category_id join shelves s on s.id = c.shelf_id where i.location_id <> s.location_id`))[0].n, 0, 'no item ever disagrees with its shelf');
});

test('moving items between categories: single and bulk (all-or-nothing); history untouched; permissions; archived items refuse', async () => {
  const c1 = await mkCategory(app, admin.token, { name: 'One' });
  const c2 = await mkCategory(app, admin.token, { name: 'Two' });
  const a = await mkItem(app, admin.token, { type: 'asset', categoryId: c1.id });
  const b = await mkItem(app, admin.token, { type: 'consumable', categoryId: c1.id, openingQuantity: 4 });
  const c = await mkItem(app, admin.token, { type: 'consumable', categoryId: c1.id, openingQuantity: 4 });
  const m = await call(app, admin.token, 'POST', `/items/${a.id}/move`, { categoryId: c2.id });
  assert.deepEqual([m.statusCode, m.json().categoryId, m.json().categoryName], [200, c2.id, 'Two']);
  assert.equal(a.itemNumber, m.json().itemNumber, 'the Item ID never changes');

  const bad = await call(app, admin.token, 'POST', '/items/move', { itemIds: [b.id, crypto.randomUUID()], categoryId: c2.id });
  assert.equal(bad.statusCode, 404);
  assert.equal((await item(b.id)).categoryId, c1.id, 'bulk move is atomic: the good id was rolled back too');
  const ok = await call(app, admin.token, 'POST', '/items/move', { itemIds: [a.id, b.id, c.id, b.id], categoryId: c2.id });
  assert.deepEqual(ok.json(), { moved: 2, unchanged: 1 }, 'duplicates collapsed; the already-there item is "unchanged"');
  assert.equal((await get(admin.token, `/categories/${c2.id}`)).itemCount, 3);
  assert.equal((await get(admin.token, `/categories/${c1.id}`)).itemCount, 0);

  assert.equal((await call(app, staff.token, 'POST', `/items/${a.id}/move`, { categoryId: c1.id })).statusCode, 403, 'staff need the item-management setting');
  await call(app, admin.token, 'PATCH', '/organization/settings', { staffCanManageItems: true });
  assert.equal((await call(app, staff.token, 'POST', `/items/${a.id}/move`, { categoryId: c1.id })).statusCode, 200);
  await call(app, admin.token, 'POST', `/items/${c.id}/archive`);
  assert.equal((await call(app, admin.token, 'POST', `/items/${c.id}/move`, { categoryId: c1.id })).json().error.code, 'ITEM_ARCHIVED');
  assert.equal((await call(app, admin.token, 'POST', '/items/move', { itemIds: [], categoryId: c1.id })).statusCode, 400);
  const types = rows(await db.execute(sql`select type from transactions where item_id = ${a.id} order by seq`)).map((r) => r.type);
  assert.deepEqual(types, ['create'], 'a move is a re-filing, not a stock movement: the ledger is untouched');
  assert.equal(rows(await db.execute(sql`select count(*)::int n from audit_events where action = 'item.moved'`))[0].n, 4, 'every actual move is audited (1 single + 2 bulk + 1 by staff); the "unchanged" one is not');
});

test('archive rules: parents with active children cannot be archived; restores respect the hierarchy', async () => {
  const shelf = await mkShelf(app, admin.token, { name: 'Rack' });
  const cat = await mkCategory(app, admin.token, { shelfId: shelf.id, name: 'Drills' });
  const it = await mkItem(app, admin.token, { type: 'asset', categoryId: cat.id });
  const e1 = await call(app, admin.token, 'POST', `/shelves/${shelf.id}/archive`);
  assert.deepEqual([e1.statusCode, e1.json().error.code, e1.json().error.details.categoryCount], [409, 'SHELF_NOT_EMPTY', 1]);
  const e2 = await call(app, admin.token, 'POST', `/categories/${cat.id}/archive`);
  assert.deepEqual([e2.statusCode, e2.json().error.code, e2.json().error.details.itemCount], [409, 'CATEGORY_NOT_EMPTY', 1]);

  await call(app, admin.token, 'POST', `/items/${it.id}/archive`);
  assert.equal((await call(app, admin.token, 'POST', `/categories/${cat.id}/archive`)).statusCode, 204);
  assert.equal((await call(app, admin.token, 'POST', '/items/' + it.id + '/restore')).json().error.code, 'CATEGORY_ARCHIVED', 'an item cannot come back into an archived category');
  assert.equal((await call(app, admin.token, 'POST', `/shelves/${shelf.id}/archive`)).statusCode, 204);
  assert.equal((await call(app, admin.token, 'POST', `/categories/${cat.id}/restore`)).json().error.code, 'SHELF_ARCHIVED');
  assert.equal((await call(app, admin.token, 'POST', '/categories', { shelfId: shelf.id, name: 'New' })).json().error.code, 'SHELF_ARCHIVED', 'nothing can be put on an archived shelf');
  assert.equal((await call(app, admin.token, 'PATCH', `/shelves/${shelf.id}`, { name: 'Renamed' })).json().error.code, 'SHELF_ARCHIVED');

  assert.equal((await call(app, admin.token, 'POST', `/shelves/${shelf.id}/restore`)).statusCode, 200);
  assert.equal((await call(app, admin.token, 'POST', `/categories/${cat.id}/restore`)).statusCode, 200);
  assert.equal((await call(app, admin.token, 'POST', `/items/${it.id}/restore`)).statusCode, 200);
  assert.equal((await call(app, admin.token, 'POST', `/shelves/${shelf.id}/restore`)).json().error.code, 'SHELF_NOT_ARCHIVED');
  assert.ok((await get(admin.token, '/shelves?includeArchived=true')).items.length >= 2);
  const acts = rows(await db.execute(sql`select action from audit_events where action like 'shelf.%' or action like 'category.%' order by seq`)).map((r) => r.action);
  for (const a of ['shelf.created', 'shelf.archived', 'shelf.restored', 'category.created', 'category.archived', 'category.restored']) assert.ok(acts.includes(a), a);
});

test('COLLECTIONS: per-shelf and per-category rollups that always equal the underlying lists', async () => {
  const john = await mkHolder(app, staff.token, 'John Okafor');
  const rack = await mkShelf(app, admin.token, { name: 'Power rack' });
  const bins = await mkShelf(app, admin.token, { name: 'Bin wall' });
  const drills = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'Drills' });
  const saws = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'Saws' });
  const gloves = await mkCategory(app, admin.token, { shelfId: bins.id, name: 'Gloves', defaultMinQuantity: 50 });
  await mkCategory(app, admin.token, { shelfId: bins.id, name: 'Empty one' });
  const d1 = await mkItem(app, admin.token, { type: 'asset', categoryId: drills.id });
  const d2 = await mkItem(app, admin.token, { type: 'asset', categoryId: drills.id });
  const d3 = await mkItem(app, admin.token, { type: 'asset', categoryId: drills.id });
  await mkItem(app, admin.token, { type: 'asset', categoryId: saws.id });
  await mkItem(app, admin.token, { type: 'consumable', categoryId: gloves.id, openingQuantity: 37 });
  await mkItem(app, admin.token, { type: 'consumable', categoryId: gloves.id, openingQuantity: 400 });
  await tx(staff.token, 'checkout', { itemId: d1.id, holderId: john.id });
  await tx(staff.token, 'checkout', { itemId: d2.id, holderId: john.id });
  await tx(sup.token, 'condition', { itemId: d3.id, toState: 'under_repair', note: 'Chuck seized' });
  await db.execute(sql`update items set due_at = now() - interval '3 hours' where id = ${d1.id}`);

  const col = await get(viewer.token, '/collections');
  const shelf = (n: string) => col.shelves.find((s: any) => s.name === n);
  const cat = (s: string, n: string) => shelf(s).categories.find((c: any) => c.name === n);
  assert.deepEqual(cat('Power rack', 'Drills').stats, { assets: 3, products: 0, units: 0, checkedOut: 2, underRepair: 1, damaged: 0, lost: 0, lowStock: 0, nearMinimum: 0, overdue: 1 });
  assert.deepEqual(cat('Power rack', 'Drills').attention, ['overdue', 'under_repair']);
  assert.deepEqual([cat('Bin wall', 'Gloves').stats.products, cat('Bin wall', 'Gloves').stats.units, cat('Bin wall', 'Gloves').stats.lowStock], [2, 437, 1]);
  assert.deepEqual(cat('Bin wall', 'Gloves').attention, ['low_stock']);
  assert.deepEqual(cat('Bin wall', 'Empty one').stats, { assets: 0, products: 0, units: 0, checkedOut: 0, underRepair: 0, damaged: 0, lost: 0, lowStock: 0, nearMinimum: 0, overdue: 0 }, 'empty categories still appear');
  assert.deepEqual(cat('Bin wall', 'Empty one').attention, []);
  assert.deepEqual([shelf('Power rack').stats.assets, shelf('Power rack').stats.checkedOut, shelf('Power rack').stats.overdue, shelf('Power rack').categories.length], [4, 2, 1, 2], 'a shelf rolls up its categories');
  assert.ok(col.shelves.some((s: any) => s.name === 'Main shelf'), 'the seeded shelf is listed too');

  // the numbers are the same numbers the detail views show
  assert.equal(shelf('Power rack').stats.overdue + shelf('Bin wall').stats.overdue, (await get(viewer.token, '/overdue')).items.length);
  assert.equal(col.shelves.reduce((n: number, s: any) => n + s.stats.lowStock, 0), (await get(viewer.token, '/low-stock')).items.length);
  assert.equal(col.shelves.reduce((n: number, s: any) => n + s.stats.checkedOut, 0), (await get(viewer.token, '/outstanding?type=asset')).items.length);
  assert.deepEqual((await get(viewer.token, `/collections?shelfId=${bins.id}`)).shelves.map((s: any) => s.name), ['Bin wall']);

  await call(app, admin.token, 'POST', `/items/${(await get(admin.token, `/items?categoryId=${saws.id}`)).items[0].id}/archive`);
  assert.equal(cat('Power rack', 'Saws').stats.assets, 1, 'sanity: stale object');
  assert.equal((await get(viewer.token, '/collections')).shelves.find((s: any) => s.name === 'Power rack').categories.find((c: any) => c.name === 'Saws').stats.assets, 0, 'archived items drop out of the rollups');
});

test('"count against the shelf": a shelf-scoped reconciliation covers every category on it, and nothing else', async () => {
  const rack = await mkShelf(app, admin.token, { name: 'Rack' });
  const other = await mkShelf(app, admin.token, { name: 'Other rack' });
  const c1 = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'A' });
  const c2 = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'B' });
  const c3 = await mkCategory(app, admin.token, { shelfId: other.id, name: 'C' });
  const i1 = await mkItem(app, admin.token, { type: 'consumable', categoryId: c1.id, openingQuantity: 10 });
  const i2 = await mkItem(app, admin.token, { type: 'consumable', categoryId: c2.id, openingQuantity: 20 });
  const i3 = await mkItem(app, admin.token, { type: 'consumable', categoryId: c3.id, openingQuantity: 30 });
  const s = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'shelf', scopeId: rack.id })).json();
  assert.equal(s.scope, 'shelf');
  assert.deepEqual((await get(sup.token, `/reconciliations/${s.id}/expected`)).items.map((i: any) => i.itemId).sort(), [i1.id, i2.id].sort());
  assert.equal((await callIdem(app, sup.token, 'POST', `/reconciliations/${s.id}/counts`, { itemId: i1.id, physicalQuantity: 10 })).json().count.resolution, 'matched');
  assert.equal((await callIdem(app, sup.token, 'POST', `/reconciliations/${s.id}/counts`, { itemId: i2.id, physicalQuantity: 18, reason: 'two short' })).json().count.variance, -2);
  assert.equal((await callIdem(app, sup.token, 'POST', `/reconciliations/${s.id}/counts`, { itemId: i3.id, physicalQuantity: 30 })).json().error.code, 'OUT_OF_SCOPE', 'an item on another shelf is not part of this count');
  // move an item onto the shelf and it is in scope
  await call(app, admin.token, 'POST', `/items/${i3.id}/move`, { categoryId: c1.id });
  assert.equal((await callIdem(app, sup.token, 'POST', `/reconciliations/${s.id}/counts`, { itemId: i3.id, physicalQuantity: 30 })).statusCode, 201);
  const theirs = await registerOrg(app, 'Rival');
  assert.equal((await callIdem(app, (await createUser(app, theirs, 'supervisor')).token, 'POST', '/reconciliations', { scope: 'shelf', scopeId: rack.id })).json().error.code, 'SCOPE_NOT_FOUND');
  assert.deepEqual(await findViolations(db), []);
});

test('import is shelf-aware: every row needs a category; new categories go on a named or default shelf', async () => {
  const rack = await mkShelf(app, admin.token, { name: 'Power rack' });
  const cat = await seededCatalog(app, admin.token);
  const up = async (csv: string) => {
    const m = multipart(Buffer.from(csv), 'i.csv', 'text/csv');
    return (await app.inject({ method: 'POST', url: '/v1/imports', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${admin.token}` } })).json();
  };
  const validate = (id: string, body: object) => call(app, admin.token, 'POST', `/imports/${id}/validate`, body);
  const MAP = { name: 'Name', type: 'Type', category: 'Category', shelf: 'Shelf', quantity: 'Qty' };

  const csv = ['Name,Type,Category,Shelf,Qty', 'Drill A,asset,Drills,Power rack,', 'Gloves,consumable,PPE,,40', 'Mystery,asset,Misc,Nowhere shelf,', 'No cat,consumable,,,5'].join('\n');
  const u1 = await up(csv);
  const v1 = (await validate(u1.import.id, { mapping: MAP, createCategories: true })).json().summary;
  const codes = (row: number) => v1.issues.filter((i: any) => i.row === row).map((i: any) => i.code);
  assert.deepEqual([codes(3), codes(4), codes(5)], [['SHELF_REQUIRED'], ['UNKNOWN_SHELF'], ['CATEGORY_REQUIRED']], 'PPE has no shelf; "Nowhere shelf" does not exist; row 5 has no category');
  assert.equal(v1.valid, 1);

  const v2 = (await validate(u1.import.id, { mapping: MAP, createCategories: true, defaults: { shelfId: cat.shelfId, categoryId: cat.categoryId } })).json().summary;
  assert.deepEqual([v2.valid, v2.invalid], [3, 1], 'a default shelf and default category rescue rows 3 and 5; the unknown shelf stays invalid');
  const done = await call(app, admin.token, 'POST', `/imports/${u1.import.id}/commit`);
  assert.deepEqual(done.json().result, { imported: 3, skipped: 0, failed: 1 });
  const cats = (await get(admin.token, '/categories')).items;
  assert.equal(cats.find((c: any) => c.name === 'Drills').shelfId, rack.id, 'created on the shelf the row named');
  assert.equal(cats.find((c: any) => c.name === 'PPE').shelfId, cat.shelfId, 'created on the default shelf');
  assert.equal((await get(admin.token, '/items?q=No%20cat')).items[0].categoryName, 'General', 'rows with no category use the default category');
  assert.deepEqual(await findViolations(db), []);
});

test('tenant isolation: another organization cannot see or touch my shelves, categories or collections', async () => {
  const other = await registerOrg(app, 'Rival');
  const rack = await mkShelf(app, admin.token, { name: 'Secret rack' });
  const cat = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'Secret cat' });
  for (const [m, u, b] of [['GET', `/shelves/${rack.id}`], ['PATCH', `/shelves/${rack.id}`, { name: 'x' }], ['POST', `/shelves/${rack.id}/archive`], ['GET', `/shelves/${rack.id}/qr`], ['GET', '/shelves/lookup?code=SHF-0002'], ['GET', `/categories/${cat.id}`], ['POST', `/categories/${cat.id}/move`, { shelfId: (await get(other.token, '/shelves')).items[0].id }], ['POST', `/categories/${cat.id}/archive`]] as const) {
    const r = await call(app, other.token, m, u, b as never);
    assert.ok([404, 422].includes(r.statusCode), `${m} ${u} -> ${r.statusCode}`);
  }
  assert.ok(!JSON.stringify(await get(other.token, '/collections')).includes('Secret'));
  assert.ok(!JSON.stringify(await get(other.token, '/shelves')).includes('Secret'));
  assert.equal((await get(admin.token, `/categories/${cat.id}`)).shelfId, rack.id, 'untouched');
  assert.equal((await get(other.token, '/collections')).shelves.length, 1, 'they see only their own seeded shelf');
});

test('the inventory report shows each item\'s shelf and category', async () => {
  const rack = await mkShelf(app, admin.token, { name: 'Power rack' });
  const cat = await mkCategory(app, admin.token, { shelfId: rack.id, name: 'Drills' });
  await mkItem(app, admin.token, { type: 'asset', name: 'Makita', categoryId: cat.id });
  const rep = await get(sup.token, '/reports/inventory');
  assert.ok(rep.columns.some((c: any) => c.key === 'shelf'));
  assert.deepEqual([rep.rows[0].shelf, rep.rows[0].category], ['Power rack', 'Drills']);
});
