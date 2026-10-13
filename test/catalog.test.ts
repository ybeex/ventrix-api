import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { setBreaker } from '../src/lib/resilience/circuit.js';
import { transactions, items } from '../src/db/schema.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkCategory, mkItem, mkHolder, upload, PNG, multipart, idem, type App, type Session, rejectsDb, seededCatalog } from './helpers.js';

let app: App;
let admin: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); admin = await registerOrg(app); });

/** POST /items with the org's seeded category unless the body names one (every item now needs a category). */
const postItem = async (token: string, body: Record<string, unknown>, key?: string) => callIdem(app, token, 'POST', '/items', { categoryId: (await seededCatalog(app, token)).categoryId, ...body }, key as never);
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, unknown>>;

test('human Item IDs come from the category prefix; counters are per-prefix, gapless and unique under concurrency', async () => {
  const drl = await mkCategory(app, admin.token, { name: 'Drills', codePrefix: 'DRL' });
  const a = await mkItem(app, admin.token, { type: 'asset', categoryId: drl.id });
  const b = await mkItem(app, admin.token, { type: 'asset', categoryId: drl.id });
  const c = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5 });
  const d = await mkItem(app, admin.token, { type: 'asset' });
  assert.deepEqual([a.itemNumber, b.itemNumber, c.itemNumber, d.itemNumber], ['DRL-0001', 'DRL-0002', 'STK-0001', 'AST-0001']);
  assert.equal(a.code, 'DRL-0001', 'every item is scannable by default');

  const many = await Promise.all(Array.from({ length: 20 }, () => postItem(admin.token, { type: 'asset', name: 'Concurrent', categoryId: drl.id })));
  assert.ok(many.every((r) => r.statusCode === 201));
  const numbers = many.map((r) => r.json().itemNumber as string).sort();
  assert.equal(new Set(numbers).size, 20);
  assert.equal(numbers[0], 'DRL-0003');
  assert.equal(numbers[19], 'DRL-0022', 'no gaps');
});

test('creation writes the opening balance to the ledger; balance is provable from signed deltas', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 120, minQuantity: 20, unit: 'boxes' });
  assert.equal(cons.quantityAvailable, 120);
  assert.equal(cons.unit, 'boxes');
  const asset = await mkItem(app, admin.token, { type: 'asset', name: 'Drill 042' });
  assert.equal(asset.assetState, 'available');
  assert.equal(asset.condition, 'good');
  const [c] = rows(await db.execute(sql`select type, stock_delta, balance_before, balance_after from transactions where item_id = ${cons.id}`));
  assert.deepEqual([c.type, c.stock_delta, c.balance_before, c.balance_after], ['create', 120, 0, 120]);
  const [proof] = rows(await db.execute(sql`select i.quantity_available as q, coalesce(sum(t.stock_delta),0)::int as ledger from items i left join transactions t on t.item_id = i.id where i.id = ${cons.id} group by i.id`));
  assert.equal(proof.q, proof.ledger);
  const audits = rows(await db.execute(sql`select action from audit_events where entity_id = ${cons.id}`));
  assert.ok(audits.some((a) => a.action === 'transaction.create'), 'every ledger row has an audit event');
});

test('type-specific rules: assets take no quantities; consumables take no expected-return period', async () => {
  assert.equal((await postItem(admin.token, { type: 'asset', name: 'X', openingQuantity: 3 })).statusCode, 422);
  assert.equal((await postItem(admin.token, { type: 'asset', name: 'X', minQuantity: 3 })).statusCode, 422);
  assert.equal((await postItem(admin.token, { type: 'consumable', name: 'X', expectedReturnHours: 4 })).statusCode, 422);
});

test('REGRESSION: stock and state can never be written through the item API (they change only via ledger operations)', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const asset = await mkItem(app, admin.token, { type: 'asset' });
  for (const bad of [{ quantityAvailable: 999 }, { assetState: 'retired' }, { condition: 'good' }, { type: 'asset' }, { currentHolderId: crypto.randomUUID() }, { orgId: crypto.randomUUID() }, { itemNumber: 'HACK-0001' }, { archivedAt: null }]) {
    assert.equal((await call(app, admin.token, 'PATCH', `/items/${cons.id}`, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await call(app, admin.token, 'PATCH', `/items/${asset.id}`, { minQuantity: 5 })).statusCode, 422);
  const [row] = await db.select().from(items).where(eq(items.id, cons.id));
  assert.equal(row.quantityAvailable, 10);
});

test('item creation is idempotent: replay returns the same item; reused key with a different body is 409; concurrent duplicates create one item', async () => {
  assert.equal((await call(app, admin.token, 'POST', '/items', { type: 'asset', name: 'No key' })).statusCode, 400);
  const key = idem();
  const body = { type: 'consumable', name: 'Gloves', openingQuantity: 50 };
  const first = await postItem(admin.token, body, key);
  const second = await postItem(admin.token, body, key);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['idempotent-replayed'], 'true');
  assert.equal(first.json().id, second.json().id);
  assert.equal((await postItem(admin.token, { ...body, openingQuantity: 51 }, key)).json().error.code, 'IDEMPOTENCY_KEY_REUSED');

  const k2 = idem();
  const par = await Promise.all(Array.from({ length: 10 }, () => postItem(admin.token, { type: 'asset', name: 'Race drill' }, k2)));
  assert.equal(new Set(par.map((r) => r.json().id)).size, 1);
  assert.equal(par.filter((r) => r.statusCode === 201).length, 1);
  const [{ n }] = rows(await db.execute(sql`select count(*)::int as n from items where name = 'Race drill'`)) as [{ n: number }];
  assert.equal(n, 1);
});

test('SKU and code uniqueness apply to active items; archive frees them; restore re-checks', async () => {
  const a = await mkItem(app, admin.token, { type: 'consumable', sku: 'BOLT-M8', openingQuantity: 1 });
  assert.equal((await postItem(admin.token, { type: 'consumable', name: 'Dup', sku: 'BOLT-M8' })).json().error.code, 'SKU_TAKEN');
  assert.equal((await call(app, admin.token, 'POST', `/items/${a.id}/archive`)).statusCode, 200);
  const b = await mkItem(app, admin.token, { type: 'consumable', sku: 'BOLT-M8', openingQuantity: 1 }); // reusable now
  const restore = await call(app, admin.token, 'POST', `/items/${a.id}/restore`);
  assert.equal(restore.statusCode, 409);
  assert.equal(restore.json().error.code, 'SKU_TAKEN');
  assert.ok(b.id);
  const custom = await mkItem(app, admin.token, { type: 'asset', code: 'TAG-7731' });
  assert.equal(custom.code, 'TAG-7731');
  // a custom code may never equal another item's Item ID (it would make that item unreachable by its own ID)
  assert.equal((await postItem(admin.token, { type: 'asset', name: 'r', code: custom.itemNumber })).json().error.code, 'CODE_TAKEN');
  assert.equal((await call(app, admin.token, 'PATCH', `/items/${b.id}`, { code: custom.itemNumber })).json().error.code, 'CODE_TAKEN');
  // …and generated Item IDs skip numbers a custom code already claimed, so defaults never collide
  const drl = await mkCategory(app, admin.token, { name: 'Drills', codePrefix: 'DRL' });
  await mkItem(app, admin.token, { type: 'asset', code: 'DRL-0002' });
  const d1 = await mkItem(app, admin.token, { type: 'asset', categoryId: drl.id });
  const d2 = await mkItem(app, admin.token, { type: 'asset', categoryId: drl.id });
  assert.deepEqual([d1.itemNumber, d2.itemNumber], ['DRL-0001', 'DRL-0003']);
  assert.equal((await postItem(admin.token, { type: 'asset', name: 'r', code: 'has space' })).statusCode, 400);
});

test('search covers name, SKU, Item ID, category and is literal (LIKE metacharacters do not widen it)', async () => {
  const tools = await mkCategory(app, admin.token, { name: 'Hand Tools', codePrefix: 'HND' });
  await mkItem(app, admin.token, { type: 'asset', name: 'Makita Drill', sku: 'MK-DR-18', categoryId: tools.id });
  await mkItem(app, admin.token, { type: 'consumable', name: '100% Cotton Rags', openingQuantity: 3 });
  await mkItem(app, admin.token, { type: 'consumable', name: 'Welding Rods', openingQuantity: 3 });
  const search = async (q: string) => (await call(app, admin.token, 'GET', `/items?q=${encodeURIComponent(q)}`)).json().items.map((i: { name: string }) => i.name);
  assert.deepEqual(await search('makita'), ['Makita Drill']);
  assert.deepEqual(await search('MK-DR'), ['Makita Drill']);
  assert.deepEqual(await search('HND-0001'), ['Makita Drill']);
  assert.deepEqual(await search('hand tools'), ['Makita Drill']);
  assert.deepEqual(await search('%'), ['100% Cotton Rags'], '% is matched literally');
  assert.deepEqual(await search('_'), [], '_ is matched literally');
  assert.equal((await call(app, admin.token, 'GET', '/items?status=bogus')).statusCode, 400, 'REGRESSION: invalid enum filter is a 400, not a 500');
  assert.equal((await call(app, admin.token, 'GET', '/items?type=asset')).json().items.length, 1);
});

test('low-stock flag uses item minimum, else category default, else not monitored', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Fasteners', defaultMinQuantity: 50 });
  const own = await mkItem(app, admin.token, { type: 'consumable', name: 'Own min', openingQuantity: 5, minQuantity: 5 });
  const inherits = await mkItem(app, admin.token, { type: 'consumable', name: 'Inherits', openingQuantity: 40, categoryId: cat.id });
  const none = await mkItem(app, admin.token, { type: 'consumable', name: 'Unmonitored', openingQuantity: 0 });
  const fine = await mkItem(app, admin.token, { type: 'consumable', name: 'Fine', openingQuantity: 500, categoryId: cat.id });
  assert.equal(own.lowStock, true);
  assert.equal(inherits.lowStock, true);
  assert.equal(inherits.effectiveMinQuantity, 50);
  assert.equal(none.lowStock, false);
  assert.equal(fine.lowStock, false);
  const low = (await call(app, admin.token, 'GET', '/items?lowStock=true')).json().items.map((i: { name: string }) => i.name).sort();
  assert.deepEqual(low, ['Inherits', 'Own min']);
});

test('scan lookup resolves by code or Item ID (case-insensitive); QR encodes exactly that code', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset', code: 'TAG-7731' });
  const byCode = await call(app, admin.token, 'GET', '/items/lookup?code=TAG-7731');
  assert.equal(byCode.json().id, a.id);
  assert.equal((await call(app, admin.token, 'GET', `/items/lookup?code=${a.itemNumber.toLowerCase()}`)).json().id, a.id);
  assert.equal((await call(app, admin.token, 'GET', '/items/lookup?code=NOPE-1')).statusCode, 404);
  const svg = await call(app, admin.token, 'GET', `/items/${a.id}/qr`);
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.match(svg.body, /^<svg/);
  const png = await call(app, admin.token, 'GET', `/items/${a.id}/qr?format=png`);
  assert.equal(png.rawPayload.subarray(1, 4).toString(), 'PNG');
});

test('archive/restore: hidden from lists, immutable while archived, ledger-recorded, state guards', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset', name: 'Old saw' });
  const archived = await call(app, admin.token, 'POST', `/items/${a.id}/archive`, { note: 'Retired from use' });
  assert.equal(archived.statusCode, 200);
  assert.ok(archived.json().archivedAt);
  assert.equal((await call(app, admin.token, 'POST', `/items/${a.id}/archive`)).json().error.code, 'ITEM_ARCHIVED');
  assert.equal((await call(app, admin.token, 'PATCH', `/items/${a.id}`, { name: 'x' })).json().error.code, 'ITEM_ARCHIVED');
  assert.equal((await call(app, admin.token, 'GET', '/items')).json().items.length, 0);
  assert.equal((await call(app, admin.token, 'GET', '/items?archived=only')).json().items.length, 1);
  assert.equal((await call(app, admin.token, 'GET', `/items/${a.id}`)).statusCode, 200, 'still resolvable for history');
  assert.equal((await call(app, admin.token, 'POST', `/items/${a.id}/restore`)).statusCode, 200);
  assert.equal((await call(app, admin.token, 'POST', `/items/${a.id}/restore`)).json().error.code, 'ITEM_NOT_ARCHIVED');
  const types = rows(await db.execute(sql`select type from transactions where item_id = ${a.id} order by seq`)).map((r) => r.type);
  assert.deepEqual(types, ['create', 'archive', 'restore']);
});

test('timeline is strictly ordered by ledger sequence (newest first) and paginates without gaps or repeats', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset' });
  for (let i = 0; i < 3; i++) { await call(app, admin.token, 'POST', `/items/${a.id}/archive`); await call(app, admin.token, 'POST', `/items/${a.id}/restore`); }
  const seen: number[] = [];
  let cursor: string | null = null;
  do {
    const r: { json(): { items: Array<{ sequence: number; type: string }>; nextCursor: string | null } } = await call(app, admin.token, 'GET', `/items/${a.id}/timeline?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    const page = r.json();
    seen.push(...page.items.map((i) => i.sequence));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 7);
  assert.deepEqual(seen, [...seen].sort((x, y) => y - x), 'descending, strictly monotonic');
  assert.equal(new Set(seen).size, 7);
  assert.equal((await call(app, admin.token, 'GET', `/items/${a.id}/timeline?cursor=garbage`)).statusCode, 400, 'REGRESSION: bad cursor is a 400');
});

test('RBAC for items: viewers read only; staff need the org setting to manage items; only admins archive', async () => {
  const viewer = await createUser(app, admin, 'viewer');
  const staff = await createUser(app, admin, 'store_staff');
  const a = await mkItem(app, admin.token, { type: 'asset' });
  assert.equal((await call(app, viewer.token, 'GET', `/items/${a.id}`)).statusCode, 200);
  assert.equal((await postItem(viewer.token, { type: 'asset', name: 'v' })).statusCode, 403);
  assert.equal((await postItem(staff.token, { type: 'asset', name: 's' })).statusCode, 403);
  await call(app, admin.token, 'PATCH', '/organization/settings', { staffCanManageItems: true });
  assert.equal((await postItem(staff.token, { type: 'asset', name: 's' })).statusCode, 201, 'setting is live immediately (cache invalidated)');
  assert.equal((await call(app, staff.token, 'POST', `/items/${a.id}/archive`)).statusCode, 403);
  assert.equal((await call(app, admin.token, 'POST', `/items/${a.id}/archive`)).statusCode, 200);
});

test('tenant isolation: another org cannot read, edit, archive, look up or reference these records', async () => {
  const other = await registerOrg(app, 'Other Org');
  const cat = await mkCategory(app, admin.token, { name: 'Mine' });
  const a = await mkItem(app, admin.token, { type: 'asset', code: 'SECRET-1', categoryId: cat.id });
  const photo = await upload(app, admin.token, 'item_photo');
  for (const [m, u] of [['GET', `/items/${a.id}`], ['PATCH', `/items/${a.id}`], ['POST', `/items/${a.id}/archive`], ['GET', `/items/${a.id}/timeline`], ['GET', `/items/${a.id}/qr`], ['GET', '/items/lookup?code=SECRET-1'], ['GET', `/files/${photo.json().id}`]] as const) {
    assert.equal((await call(app, other.token, m, u, m === 'PATCH' ? { name: 'x' } : undefined)).statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await call(app, other.token, 'GET', '/items')).json().items.length, 0);
  assert.equal((await postItem(other.token, { type: 'asset', name: 'x', categoryId: cat.id })).json().error.code, 'CATEGORY_NOT_FOUND');
  assert.equal((await postItem(other.token, { type: 'asset', name: 'x', photoFileId: photo.json().id })).json().error.code, 'FILE_NOT_FOUND');
  assert.equal((await postItem(other.token, { type: 'asset', name: 'x', locationId: crypto.randomUUID() })).statusCode, 400, 'location is derived from the shelf and is not an accepted input');
});

test('holders: workers need no login; teams are admin-only; members; linked-user holders cannot be archived; search', async () => {
  const staff = await createUser(app, admin, 'store_staff');
  const worker = await call(app, staff.token, 'POST', '/holders', { kind: 'person', name: 'John Okafor', code: 'EMP-204' });
  assert.equal(worker.statusCode, 201);
  assert.equal(worker.json().userId, null);
  assert.equal((await call(app, staff.token, 'POST', '/holders', { kind: 'team', name: 'Electrical Team' })).statusCode, 403);
  const team = await call(app, admin.token, 'POST', '/holders', { kind: 'team', name: 'Electrical Team' });
  assert.equal(team.statusCode, 201);
  assert.equal((await call(app, admin.token, 'PUT', `/holders/${team.json().id}/members`, { personIds: [worker.json().id] })).statusCode, 200);
  assert.deepEqual((await call(app, staff.token, 'GET', `/holders/${team.json().id}/members`)).json().items.map((m: { name: string }) => m.name), ['John Okafor']);
  assert.equal((await call(app, admin.token, 'PUT', `/holders/${worker.json().id}/members`, { personIds: [] })).json().error.code, 'NOT_A_TEAM');
  assert.equal((await call(app, admin.token, 'PUT', `/holders/${team.json().id}/members`, { personIds: [team.json().id] })).json().error.code, 'MEMBER_NOT_FOUND');
  assert.equal((await call(app, staff.token, 'PUT', `/holders/${team.json().id}/members`, { personIds: [] })).statusCode, 403);

  const people = (await call(app, admin.token, 'GET', '/holders?kind=person&q=okafor')).json().items;
  assert.deepEqual(people.map((p: { name: string }) => p.name), ['John Okafor']);
  assert.equal((await call(app, admin.token, 'GET', '/holders?q=EMP-204')).json().items.length, 1, 'badge number search');
  const mine = (await call(app, admin.token, 'GET', '/holders?kind=person')).json().items.find((h: { userId: string | null }) => h.userId === admin.userId);
  assert.equal((await call(app, admin.token, 'POST', `/holders/${mine.id}/archive`)).json().error.code, 'HOLDER_LINKED_TO_USER');
  assert.equal((await call(app, admin.token, 'POST', `/holders/${worker.json().id}/archive`)).statusCode, 204);
  assert.equal((await call(app, admin.token, 'GET', '/holders?q=okafor')).json().items.length, 0);
});

test('jobs & categories: CRUD, uniqueness, validation', async () => {
  const j = await call(app, admin.token, 'POST', '/jobs', { name: 'Project Alpha', code: 'ALPHA' });
  assert.equal(j.statusCode, 201);
  assert.equal((await call(app, admin.token, 'POST', '/jobs', { name: 'Dup', code: 'ALPHA' })).json().error.code, 'JOB_CODE_TAKEN');
  assert.equal((await call(app, admin.token, 'PATCH', `/jobs/${j.json().id}`, { status: 'closed' })).json().status, 'closed');
  const staff = await createUser(app, admin, 'store_staff');
  assert.equal((await call(app, staff.token, 'POST', '/jobs', { name: 'x' })).statusCode, 403);
  await mkCategory(app, admin.token, { name: 'Power Tools', codePrefix: 'PWR' });
  assert.equal((await call(app, admin.token, 'POST', '/categories', { shelfId: (await seededCatalog(app, admin.token)).shelfId, name: 'power tools' })).json().error.code, 'CATEGORY_NAME_TAKEN', 'case-insensitive');
  assert.equal((await call(app, admin.token, 'POST', '/categories', { shelfId: (await seededCatalog(app, admin.token)).shelfId, name: 'Bad', codePrefix: 'a-b' })).statusCode, 400);
});

test('files: sniffed by bytes, size-capped, signed expiring URLs, tenant-scoped; storage breaker isolates failures', async () => {
  assert.equal((await upload(app, admin.token, 'item_photo', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.svg', 'image/svg+xml')).statusCode, 422);
  assert.equal((await upload(app, admin.token, 'item_photo', Buffer.from('<html>not an image</html>'), 'evil.png', 'image/png')).json().error.code, 'UNSUPPORTED_FILE_TYPE', 'a .png name and image/png header do not make it a PNG');
  assert.equal((await upload(app, admin.token, 'item_photo', Buffer.alloc(0))).statusCode, 422);
  const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
  assert.equal((await upload(app, admin.token, 'item_photo', big)).statusCode, 413);

  const ok = await upload(app, admin.token, 'item_photo');
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().contentType, 'image/png');
  const link = (await call(app, admin.token, 'GET', `/files/${ok.json().id}`)).json();
  const served = await app.inject({ method: 'GET', url: link.url }); // no bearer: authorised by the signed URL alone
  assert.equal(served.statusCode, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.equal(served.headers['x-content-type-options'], 'nosniff');
  assert.match(String(served.headers['content-security-policy']), /sandbox/);
  assert.ok(served.rawPayload.equals(PNG));
  assert.equal((await app.inject({ method: 'GET', url: link.url.replace(/sig=./, 'sig=0') })).statusCode, 401, 'tampered signature');
  const exp = Number(/exp=(\d+)/.exec(link.url)![1]);
  assert.equal((await app.inject({ method: 'GET', url: link.url.replace(`exp=${exp}`, `exp=${exp + 3600}`) })).statusCode, 401, 'extending the expiry invalidates the signature');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/files/${ok.json().id}/content?exp=${Math.floor(Date.now() / 1000) - 5}&sig=${'a'.repeat(64)}` })).statusCode, 401);

  const viewer = await createUser(app, admin, 'viewer');
  assert.equal((await upload(app, viewer.token, 'item_photo')).statusCode, 403);
  assert.equal((await call(app, viewer.token, 'GET', `/files/${ok.json().id}`)).statusCode, 200);

  // wrong kind cannot be attached as an item photo
  const snap = await upload(app, admin.token, 'transaction_snapshot');
  assert.equal((await postItem(admin.token, { type: 'asset', name: 'x', photoFileId: snap.json().id })).json().error.code, 'FILE_NOT_FOUND');
  const withPhoto = await mkItem(app, admin.token, { type: 'asset', photoFileId: ok.json().id });
  assert.equal(withPhoto.photoFileId, ok.json().id);

  // Storage outage: uploads fail fast with 503; everything else keeps working.
  await upload(app, admin.token, 'item_photo'); // make sure the breaker exists
  setBreaker('storage', 'open');
  const down = await upload(app, admin.token, 'item_photo');
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal((await call(app, admin.token, 'GET', '/items')).statusCode, 200);
  setBreaker('storage', 'closed');
  assert.equal((await upload(app, admin.token, 'item_photo')).statusCode, 201);
  void multipart;
});

test('DATABASE GUARDS: even raw SQL cannot create negative stock, orphaned state, or rewrite/delete history', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5 });
  const asset = await mkItem(app, admin.token, { type: 'asset' });
  await rejectsDb(db.execute(sql`update items set quantity_available = -1 where id = ${cons.id}`), /items_qty_nonneg|check/i);
  await rejectsDb(db.execute(sql`update items set asset_state = 'checked_out' where id = ${asset.id}`), /holder_matches_state|check/i, 'checked out to nobody');
  await rejectsDb(db.execute(sql`update items set quantity_available = 3 where id = ${asset.id}`), /type_shape|check/i, 'an asset cannot carry a quantity');
  await rejectsDb(db.execute(sql`update transactions set quantity = 999 where item_id = ${cons.id}`), /immutable/);
  await rejectsDb(db.execute(sql`delete from transactions where item_id = ${cons.id}`), /immutable/);
  await rejectsDb(db.execute(sql`update audit_events set action = 'nothing happened'`), /immutable/);
  await rejectsDb(db.execute(sql`delete from audit_events`), /immutable/);
  const [{ n }] = rows(await db.execute(sql`select count(*)::int as n from transactions`)) as [{ n: number }];
  assert.equal(n, 2);
  void transactions;
});
