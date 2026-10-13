import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkCategory, mkItem, mkHolder, upload, idem, type App, type Session, rejectsDb } from './helpers.js';

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
const start = async (token: string, scope: string, scopeId: string) => (await callIdem(app, token, 'POST', '/reconciliations', { scope, scopeId })).json();
const count = (token: string, rid: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/reconciliations/${rid}/counts`, body, key);
const setPolicy = (over: object = {}) => call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'staff_approval', lossMode: 'staff_approval', retirementMode: 'staff_approval', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: null, ...over });
const qty = async (id: string) => (await get(admin.token, `/items/${id}`)).quantityAvailable;
const integrity = async () => assert.deepEqual(await findViolations(db), []);

test('who may reconcile; scope must name something in THIS organization', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Fasteners' });
  const other = await registerOrg(app, 'Other');
  const theirCat = await mkCategory(app, other.token, { name: 'Theirs' });
  for (const t of [staff, viewer]) assert.equal((await callIdem(app, t.token, 'POST', '/reconciliations', { scope: 'category', scopeId: cat.id })).statusCode, 403);
  assert.equal((await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'category', scopeId: cat.id })).statusCode, 201);
  assert.equal((await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'category', scopeId: theirCat.id })).json().error.code, 'SCOPE_NOT_FOUND');
  assert.equal((await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: crypto.randomUUID() })).json().error.code, 'SCOPE_NOT_FOUND');
  assert.equal((await call(app, viewer.token, 'GET', '/reconciliations')).statusCode, 200, 'everyone can read results');
});

test('a matching count records a zero-effect ledger row; a variance needs a reason and never silently changes stock', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 40, name: 'Screws' });
  const s = await start(sup.token, 'item', cons.id);
  const ok = await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 40 });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().count.resolution, 'matched');
  const t = ok.json().transactions[0];
  assert.deepEqual([t.type, t.stockDelta, t.balanceBefore, t.balanceAfter, t.quantity], ['reconciliation', 0, 40, 40, 40]);

  assert.equal((await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 37 })).json().error.code, 'REASON_REQUIRED');
  const v = await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 37, reason: 'Two boxes found damaged' });
  assert.equal(v.statusCode, 201);
  assert.deepEqual([v.json().count.systemQuantity, v.json().count.physicalQuantity, v.json().count.variance, v.json().count.resolution], [40, 37, -3, 'unresolved']);
  assert.equal(await qty(cons.id), 40, 'recording a count does not move stock; resolving it is an explicit, policy-gated step');

  await call(app, admin.token, 'PATCH', '/organization/settings', { reconciliationRequireReason: false });
  assert.equal((await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 38 })).statusCode, 201, 'reason requirement is configurable (§56.4)');
  await integrity();
});

test('resolving with an adjustment: direct for a supervisor, linked to the count, stock becomes the physical figure', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 40 });
  const s = await start(sup.token, 'item', cons.id);
  const r = await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 33, reason: 'Count correction after audit', adjust: true });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().count.resolution, 'adjusted');
  assert.equal(await qty(cons.id), 33);
  const [rc, adj] = r.json().transactions;
  assert.deepEqual([rc.type, adj.type, adj.stockDelta, adj.reason, adj.relatedTransactionId], ['reconciliation', 'adjustment', -7, 'count_correction', rc.id]);
  assert.equal(r.json().count.adjustmentTransactionId, adj.id);
  assert.equal(r.json().approval, null);
  const detail = await get(viewer.token, `/reconciliations/${s.id}`);
  assert.equal(detail.counts[0].systemQuantity, 40, 'the original system quantity is preserved forever');
  assert.deepEqual([detail.summary.counted, detail.summary.adjusted, detail.summary.discrepancies], [1, 1, 1]);
  await integrity();
});

test('POLICY: reconciliation is not a back door — under approval policy the adjustment is deferred; approval resolves it, rejection leaves it open', async () => {
  await setPolicy({ adjustmentMode: 'all_approval' });
  const a = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 40, name: 'A' });
  const b = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 40, name: 'B' });
  const s = await start(sup.token, 'location', (await get(admin.token, '/locations')).items[0].id);
  const ra = await count(sup.token, s.id, { itemId: a.id, physicalQuantity: 30, reason: 'Short', adjust: true });
  const rb = await count(sup.token, s.id, { itemId: b.id, physicalQuantity: 45, reason: 'Surplus', adjust: true });
  for (const r of [ra, rb]) { assert.equal(r.statusCode, 201); assert.equal(r.json().count.resolution, 'pending_approval'); assert.ok(r.json().approval.id); }
  assert.equal(await qty(a.id), 40, 'nothing moved yet');
  assert.equal((await get(sup.token, '/dashboard')).openDiscrepancies, 2, 'pending approval is still an open discrepancy');

  assert.equal((await callIdem(app, admin.token, 'POST', `/approvals/${ra.json().approval.id}/approve`, {})).statusCode, 200);
  assert.equal(await qty(a.id), 30);
  assert.equal((await callIdem(app, admin.token, 'POST', `/approvals/${rb.json().approval.id}/reject`, { note: 'Recount first' })).statusCode, 200);
  const detail = await get(admin.token, `/reconciliations/${s.id}`);
  const by = Object.fromEntries(detail.counts.map((c: any) => [c.itemNumber, c.resolution]));
  assert.deepEqual([by[a.itemNumber], by[b.itemNumber]], ['adjusted', 'rejected'], 'resolution is derived live from the approval outcome');
  assert.equal((await get(sup.token, '/dashboard')).openDiscrepancies, 1);
  const open = await get(sup.token, '/reports/discrepancies?status=open');
  assert.equal(open.rows.length, 1);
  assert.equal(open.rows[0].resolution, 'rejected');
  const resolved = await get(sup.token, '/reports/discrepancies?status=resolved');
  assert.deepEqual(resolved.rows.map((r: any) => [r.variance, r.resolvedBy]), [[-10, 'admin person'.replace('admin person', 'Ada Admin')]]);
  await integrity();
});

test('a later matching recount closes an open discrepancy; dashboard count == open-discrepancy report, always', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const s = await start(sup.token, 'item', cons.id);
  await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 8, reason: 'Two missing' });
  assert.equal((await get(sup.token, '/dashboard')).openDiscrepancies, 1);
  assert.equal((await get(sup.token, '/reports/discrepancies?status=open')).rows.length, 1);
  await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 10 }); // found them
  assert.equal((await get(sup.token, '/dashboard')).openDiscrepancies, 0);
  assert.equal((await get(sup.token, '/reports/discrepancies?status=open')).rows.length, 0);
  assert.equal((await get(sup.token, '/reports/discrepancies?status=all')).rows.length, 1, 'history keeps the original variance');
});

test('scope is enforced; closed sessions and archived items refuse counts; the checklist tracks progress; close summarises', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Gloves' });
  const inCat = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5, categoryId: cat.id });
  const inCat2 = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5, categoryId: cat.id });
  const outside = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5 });
  const s = await start(sup.token, 'category', cat.id);
  assert.equal((await count(sup.token, s.id, { itemId: outside.id, physicalQuantity: 5 })).json().error.code, 'OUT_OF_SCOPE');
  const sItem = await start(sup.token, 'item', inCat.id);
  assert.equal((await count(sup.token, sItem.id, { itemId: inCat2.id, physicalQuantity: 5 })).json().error.code, 'OUT_OF_SCOPE');

  assert.equal((await get(sup.token, `/reconciliations/${s.id}/expected`)).items.length, 2);
  await count(sup.token, s.id, { itemId: inCat.id, physicalQuantity: 5 });
  const exp = (await get(sup.token, `/reconciliations/${s.id}/expected`)).items;
  assert.deepEqual(exp.map((i: any) => [i.itemId, i.counted]).sort(), [[inCat.id, true], [inCat2.id, false]].sort());
  assert.equal(exp.find((i: any) => i.itemId === inCat.id).systemQuantity, 5);

  await call(app, admin.token, 'POST', `/items/${inCat2.id}/archive`);
  assert.equal((await count(sup.token, s.id, { itemId: inCat2.id, physicalQuantity: 5 })).json().error.code, 'ITEM_ARCHIVED');
  assert.equal((await get(sup.token, `/reconciliations/${s.id}/expected`)).items.length, 1, 'archived items drop off the checklist');

  const closed = await callIdem(app, sup.token, 'POST', `/reconciliations/${s.id}/close`, { note: 'Done' });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json().status, 'closed');
  assert.equal((await callIdem(app, sup.token, 'POST', `/reconciliations/${s.id}/close`, {})).json().error.code, 'RECONCILIATION_CLOSED');
  assert.equal((await count(sup.token, s.id, { itemId: inCat.id, physicalQuantity: 5 })).json().error.code, 'RECONCILIATION_CLOSED');
  assert.equal((await get(sup.token, '/reconciliations?status=open')).items.length, 1, 'only the item-scope session is still open');
});

test('count idempotency: replay → 200 and no duplicate; key reuse with another figure → 409; 6 concurrent duplicates → one record', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const s = await start(sup.token, 'item', cons.id);
  const key = idem();
  const a = await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 9, reason: 'One lost' }, key);
  const b = await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 9, reason: 'One lost' }, key);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 200);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(a.json().count.id, b.json().count.id);
  assert.equal((await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 8, reason: 'x' }, key)).json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  const k2 = idem();
  const par = await Promise.all(Array.from({ length: 6 }, () => count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 10 }, k2)));
  assert.equal(new Set(par.map((r) => r.json().count.id)).size, 1);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from reconciliation_counts`))[0].n, 2);
  assert.equal((await count(sup.token, s.id, { itemId: cons.id })).statusCode, 400, 'key required');
});

test('count records are immutable at the database level', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const s = await start(sup.token, 'item', cons.id);
  await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 4, reason: 'Short' });
  await rejectsDb(db.execute(sql`update reconciliation_counts set variance = 0, reason = 'nothing to see'`), /immutable/);
  await rejectsDb(db.execute(sql`delete from reconciliation_counts`), /immutable/);
});

test('tracked assets are counted by presence: missing → loss through policy; impossible figures and unresolvable variances refused', async () => {
  const john = await mkHolder(app, staff.token, 'John Okafor');
  const here = await mkItem(app, admin.token, { type: 'asset', name: 'In store' });
  const gone = await mkItem(app, admin.token, { type: 'asset', name: 'Missing' });
  const out = await mkItem(app, admin.token, { type: 'asset', name: 'With John' });
  await tx(staff.token, 'checkout', { itemId: out.id, holderId: john.id });
  const s = await start(sup.token, 'location', (await get(admin.token, '/locations')).items[0].id);

  assert.equal((await count(sup.token, s.id, { itemId: here.id, physicalQuantity: 1 })).json().count.resolution, 'matched');
  assert.equal((await count(sup.token, s.id, { itemId: out.id, physicalQuantity: 0 })).json().count.resolution, 'matched', 'a checked-out asset is expected to be away');
  assert.equal((await count(sup.token, s.id, { itemId: here.id, physicalQuantity: 2 })).json().error.code, 'INVALID_QUANTITY');
  const found = await count(sup.token, s.id, { itemId: out.id, physicalQuantity: 1, reason: 'John left it here', adjust: true });
  assert.equal(found.json().error.code, 'ADJUSTMENT_NOT_APPLICABLE');

  const miss = await count(sup.token, s.id, { itemId: gone.id, physicalQuantity: 0, reason: 'Not on the shelf', adjust: true });
  assert.equal(miss.statusCode, 201);
  assert.equal(miss.json().transactions[1].type, 'loss');
  assert.equal((await get(admin.token, `/items/${gone.id}`)).assetState, 'lost');
  assert.equal(miss.json().count.resolution, 'adjusted');
  await integrity();
});

test('photo policy applies to reconciliation counts', async () => {
  await call(app, admin.token, 'PATCH', '/organization/settings', { requirePhotoFor: ['reconciliation'] });
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 3 });
  const s = await start(sup.token, 'item', cons.id);
  assert.equal((await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 3 })).json().error.code, 'PHOTO_REQUIRED');
  const snap = (await upload(app, sup.token, 'transaction_snapshot')).json().id;
  const ok = await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 3, snapshotFileId: snap });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().transactions[0].snapshotFileId, snap);
});

test('tenant isolation: other organizations cannot read, count against, or close my reconciliation', async () => {
  const other = await registerOrg(app, 'Rival');
  const oSup = await createUser(app, other, 'supervisor');
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 3 });
  const s = await start(sup.token, 'item', cons.id);
  assert.equal((await call(app, oSup.token, 'GET', `/reconciliations/${s.id}`)).statusCode, 404);
  assert.equal((await call(app, oSup.token, 'GET', `/reconciliations/${s.id}/expected`)).statusCode, 404);
  assert.equal((await count(oSup.token, s.id, { itemId: cons.id, physicalQuantity: 3 })).statusCode, 404);
  assert.equal((await callIdem(app, oSup.token, 'POST', `/reconciliations/${s.id}/close`, {})).statusCode, 404);
  const theirs = await mkItem(app, other.token, { type: 'consumable', openingQuantity: 3 });
  assert.equal((await count(sup.token, s.id, { itemId: theirs.id, physicalQuantity: 3 })).statusCode, 404, 'cannot count another org\'s item inside my session');
  assert.equal((await get(oSup.token, '/reconciliations')).items.length, 0);
});

test('metrics: counts and discrepancies are exported for rate monitoring (§39)', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 3 });
  const s = await start(sup.token, 'item', cons.id);
  await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 3 });
  await count(sup.token, s.id, { itemId: cons.id, physicalQuantity: 1, reason: 'x' });
  const body = (await app.inject('/metrics')).body;
  assert.match(body, /storekeeper_reconciliation_counts_total [1-9]/);
  assert.match(body, /storekeeper_reconciliation_discrepancies_total [1-9]/);
});
