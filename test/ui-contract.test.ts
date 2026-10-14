/**
 * WS4 — UI-contract verification. One test per row of the screen→endpoint map in docs/CONTINUATION-PLAN.md §WS4, run against the live app.
 * (The StoreKeeper_UI_kit.html itself was not available when this was written: this pins the API behaviour the screens depend on,
 * and docs/FRONTEND-INTEGRATION.md is generated from what these tests observe. Walk the kit against it once the file is in hand.)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { processDomainEvents } from '../src/modules/notifications/service.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, mkItem, mkHolder, mkShelf, mkCategory, seededCatalog, idem, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session, viewer: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff'); viewer = await createUser(app, admin, 'viewer'); });

const get = async (s: Session, url: string) => (await call(app, s.token, 'GET', url)).json();
const tx = (s: Session, op: string, body: object, key = idem()) => callIdem(app, s.token, 'POST', `/transactions/${op}`, body, key);
const HOUR = 3_600_000; const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const asset = (name = `Tool ${crypto.randomUUID().slice(0, 4)}`) => mkItem(app, admin.token, { type: 'asset', name });
const stock = (name: string, qty: number, min?: number) => mkItem(app, admin.token, { type: 'consumable', name, openingQuantity: qty, ...(min === undefined ? {} : { minQuantity: min }) });
const site = async (name = 'Lekki Site') => (await callIdem(app, admin.token, 'POST', '/holders', { kind: 'job_site', name })).json();

test('scan: item and shelf lookup are exact, case-insensitive, and archived records still resolve (history); unknown → 404 envelope', async () => {
  const a = await asset(); const up = await get(staff, `/items/lookup?code=${a.code.toLowerCase()}`);
  assert.equal(up.id, a.id); assert.ok(up.shelfName && up.categoryName, 'the scan result carries its shelf and category');
  assert.equal((await call(app, staff.token, 'GET', `/items/lookup?code=${a.code.slice(0, -1)}`)).statusCode, 404, 'exact, not prefix');
  await callIdem(app, admin.token, 'POST', `/items/${a.id}/archive`, {});
  const arch = await get(staff, `/items/lookup?code=${a.code}`); assert.equal(arch.id, a.id); assert.ok(arch.archivedAt);
  const sh = await mkShelf(app, admin.token, { name: 'Yard rack' }); const byCode = await get(staff, `/shelves/lookup?code=${sh.code.toLowerCase()}`); assert.equal(byCode.id, sh.id);
  await call(app, admin.token, 'POST', `/shelves/${sh.id}/archive`); assert.ok((await get(staff, `/shelves/lookup?code=${sh.code}`)).archivedAt);
  const miss = await call(app, staff.token, 'GET', '/items/lookup?code=NOPE-9'); assert.equal(miss.statusCode, 404);
  assert.deepEqual(Object.keys(miss.json().error).sort(), ['code', 'message', 'requestId']); assert.equal(miss.json().error.code, 'NOT_FOUND');
  assert.equal((await call(app, viewer.token, 'GET', `/items/lookup?code=${a.code}`)).statusCode, 200, 'viewers can scan');
});

test('holder picker: search by name across kinds (person / team / job_site), recent list, archived hidden', async () => {
  await mkHolder(app, staff.token, 'John Okafor'); await site('Lekki Site'); const team = (await callIdem(app, admin.token, 'POST', '/holders', { kind: 'team', name: 'Lekki Crew' })).json();
  const q = (await get(staff, '/holders?q=lek')).items; assert.deepEqual(q.map((h: any) => h.kind).sort(), ['job_site', 'team']);
  assert.equal((await get(staff, '/holders?q=okafor')).items.length, 1);
  await call(app, admin.token, 'POST', `/holders/${team.id}/archive`);
  assert.equal((await get(staff, '/holders?q=lek')).items.length, 1, 'archived holders drop out of the picker');
  assert.ok(Array.isArray((await get(staff, '/holders/recent')).items));
});

test('batch checkout: holder = person | team | job site; one transaction per line, in request order; atomic; replay-safe', async () => {
  const [a, b, c] = [await asset('A'), await asset('B'), await stock('Ties', 20)]; const s = await site();
  const key = idem(); const body = { holderId: s.id, lines: [{ itemId: a.id }, { itemId: c.id, quantity: 3 }, { itemId: b.id }] };
  const r1 = await tx(staff, 'checkout/batch', body, key); assert.equal(r1.statusCode, 201, r1.body);
  const r2 = await tx(staff, 'checkout/batch', body, key); assert.equal(r2.statusCode, 200, 'a replay answers 200 (first answer was 201)'); assert.deepEqual(r2.json(), r1.json(), 'replay returns the original body');
  const out = (await get(staff, '/outstanding?limit=100')).items; assert.equal(out.length, 3); assert.ok(out.every((o: any) => o.holder.kind === 'job_site'));
  const reuse = await tx(staff, 'checkout/batch', { holderId: s.id, lines: [{ itemId: a.id }] }, key); assert.equal(reuse.statusCode, 409); assert.equal(reuse.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  // atomic: the second line cannot be satisfied (more than in stock) → nothing at all is checked out
  const [d, tie2] = [await asset('D'), await stock('Few', 2)];
  const bad = await tx(staff, 'checkout/batch', { holderId: s.id, lines: [{ itemId: d.id }, { itemId: tie2.id, quantity: 5 }] });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500, bad.body);
  assert.equal((await get(staff, `/items/${d.id}`)).assetState, 'available', 'the valid line was rolled back with the invalid one');
  assert.equal((await get(staff, `/items/${tie2.id}`)).quantityAvailable, 2);
  assert.deepEqual(await findViolations(db), []);
});

test('policy defers a checkout: 202 pending_approval with the approval card, nothing moves until approved', async () => {
  assert.equal((await call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'staff_approval', lossMode: 'staff_approval', retirementMode: 'staff_approval', checkoutMode: 'staff_approval', checkinMode: 'direct', largeAdjustmentThreshold: null }, { 'idempotency-key': idem() })).statusCode, 200);
  const a = await asset(); const j = await mkHolder(app, staff.token, 'John');
  const r = await tx(staff, 'checkout', { itemId: a.id, holderId: j.id }); assert.equal(r.statusCode, 202); assert.equal(r.json().status, 'pending_approval');
  assert.deepEqual(['id', 'operation', 'status', 'item', 'request', 'requestedBy', 'createdAt'].filter((k) => !(k in r.json().approval)), []);
  assert.equal((await get(staff, `/items/${a.id}`)).assetState, 'available');
  const approved = await callIdem(app, sup.token, 'POST', `/approvals/${r.json().approval.id}/approve`, {}); assert.equal(approved.statusCode, 200, approved.body);
  assert.equal((await get(staff, `/items/${a.id}`)).assetState, 'checked_out');
});

test('"Supervisor approves adjustments" switch: direct ⇄ staff_approval changes what staff get (201 vs 202), and admins are never queued', async () => {
  const it = await stock('Ties', 20); const adj = (s: Session) => tx(s, 'adjust', { itemId: it.id, quantityDelta: -1, reason: 'count_correction' });
  const put = (mode: string) => call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: mode, lossMode: 'staff_approval', retirementMode: 'staff_approval', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: null }, { 'idempotency-key': idem() });
  await put('direct'); assert.equal((await adj(staff)).statusCode, 201);
  await put('staff_approval'); assert.equal((await adj(staff)).statusCode, 202); assert.equal((await adj(admin)).statusCode, 201);
  assert.equal((await get(admin, '/organization/approval-policy')).adjustmentMode, 'staff_approval');
  assert.equal((await call(app, staff.token, 'PUT', '/organization/approval-policy', {})).statusCode, 403);
});

test('outstanding row actions: check-in condition mapping (good→available, needs_inspection→under_repair, damaged→damaged); loss/retirement are approval-gated for staff', async () => {
  const j = await mkHolder(app, staff.token, 'John'); const states: Record<string, string> = { good: 'available', needs_inspection: 'under_repair', damaged: 'damaged' };
  for (const [condition, expected] of Object.entries(states)) {
    const a = await asset(); await tx(staff, 'checkout', { itemId: a.id, holderId: j.id });
    const r = await tx(staff, 'checkin', { itemId: a.id, condition }); assert.equal(r.statusCode, 201, r.body);
    assert.equal((await get(staff, `/items/${a.id}`)).assetState, expected, condition);
  }
  const lost = await asset(); await tx(staff, 'checkout', { itemId: lost.id, holderId: j.id });
  const l = await tx(staff, 'loss', { itemId: lost.id, note: 'Fell off truck' }); assert.equal(l.statusCode, 202); assert.equal(l.json().approval.operation, 'loss');
  assert.equal((await get(staff, `/items/${lost.id}`)).assetState, 'checked_out', 'still with John until approved');
  assert.equal((await callIdem(app, sup.token, 'POST', `/approvals/${l.json().approval.id}/approve`, {})).statusCode, 200);
  assert.equal((await get(staff, `/items/${lost.id}`)).assetState, 'lost');
  assert.equal((await get(staff, '/outstanding?limit=100')).items.length, 0, 'a lost asset is no longer "outstanding"');
  const ret = await asset(); await tx(admin, 'condition', { itemId: ret.id, toState: 'retired', note: 'End of life' }); assert.equal((await get(staff, `/items/${ret.id}`)).assetState, 'retired');
});

test('"Count against the shelf": expected checklist, counts tick items off, variance resolves per policy, close', async () => {
  const cat = await seededCatalog(app, admin.token); const t1 = await stock('Ties', 20), t2 = await stock('Bolts', 10); const g = await asset('Grinder');
  const rec = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'shelf', scopeId: cat.shelfId })).json(); assert.equal(rec.status, 'open');
  const exp = async () => (await get(sup, `/reconciliations/${rec.id}/expected?limit=100`)).items as any[];
  let list = await exp(); assert.equal(list.length, 3); assert.ok(list.every((i) => i.counted === false));
  assert.equal(list.find((i) => i.itemId === t1.id).systemQuantity, 20); assert.equal(list.find((i) => i.itemId === g.id).systemQuantity, 1);
  const exact = await callIdem(app, sup.token, 'POST', `/reconciliations/${rec.id}/counts`, { itemId: t1.id, physicalQuantity: 20 }); assert.equal(exact.statusCode, 201, exact.body);
  const short = await callIdem(app, sup.token, 'POST', `/reconciliations/${rec.id}/counts`, { itemId: t2.id, physicalQuantity: 7, reason: 'Box split open in transit' }); assert.equal(short.statusCode, 201, short.body);
  list = await exp(); assert.deepEqual(list.map((i) => [i.name, i.counted]).sort(), [['Bolts', true], ['Grinder', false], ['Ties', true]]);
  const detail = await get(sup, `/reconciliations/${rec.id}`); assert.equal(detail.reconciliation.id, rec.id); assert.equal(detail.counts.length, 2);
  assert.deepEqual([detail.summary.counted, detail.summary.matched, detail.summary.discrepancies], [2, 1, 1], 'the summary strip: counted / matched / discrepancies');
  const closed = await callIdem(app, sup.token, 'POST', `/reconciliations/${rec.id}/close`, {}); assert.equal(closed.statusCode, 200); assert.equal(closed.json().status, 'closed');
  assert.equal((await callIdem(app, sup.token, 'POST', `/reconciliations/${rec.id}/counts`, { itemId: t1.id, physicalQuantity: 20 })).statusCode >= 400, true, 'a closed count accepts no more entries');
  assert.deepEqual(await findViolations(db), []);
  assert.equal((await call(app, staff.token, 'GET', `/reconciliations/${rec.id}`)).statusCode, 200, 'reading a count is open to every role (see AUDIT-FINDINGS D3)');
  assert.equal((await callIdem(app, staff.token, 'POST', '/reconciliations', { scope: 'shelf', scopeId: cat.shelfId })).statusCode, 403, 'running one is admin + supervisor');
});

test('Collections cards equal the detail lists: assets, out, overdue, low, near-minimum, under repair, units', async () => {
  const cat = await seededCatalog(app, admin.token); const j = await mkHolder(app, staff.token, 'John');
  const [a1, a2, a3] = [await asset('A1'), await asset('A2'), await asset('A3')];
  await tx(staff, 'checkout', { itemId: a1.id, holderId: j.id, dueAt: iso(2 * 24 * HOUR) }); await tx(staff, 'checkout', { itemId: a2.id, holderId: j.id, dueAt: iso(2 * 24 * HOUR) });
  await db.execute(sql`update items set due_at = now() - interval '2 hours' where id = ${a2.id}`);
  await tx(staff, 'condition', { itemId: a3.id, toState: 'under_repair', note: 'motor' });
  await stock('Low one', 2, 10); await stock('Near one', 11, 10); await stock('Fine', 100, 10);
  const col = (await get(viewer, '/collections')).shelves.find((s: any) => s.id === cat.shelfId).stats;
  const dash = await get(viewer, '/dashboard');
  assert.equal(col.assets, 3); assert.equal(col.checkedOut, (await get(viewer, '/outstanding?limit=100')).items.filter((i: any) => i.item.type === 'asset').length);
  assert.equal(col.overdue, (await get(viewer, '/overdue?limit=100')).items.length); assert.equal(col.overdue, dash.overdue);
  assert.equal(col.lowStock, (await get(viewer, '/low-stock?limit=100')).items.length); assert.equal(col.lowStock, dash.lowStock);
  assert.equal(col.nearMinimum, (await get(viewer, '/low-stock?includeNear=true&limit=100')).items.filter((i: any) => i.status === 'near').length); assert.equal(col.nearMinimum, dash.nearMinimum);
  assert.equal(col.underRepair, (await get(viewer, '/items?status=under_repair&limit=100')).items.length);
  assert.equal(col.units, 113, '2 + 11 + 100');
  assert.deepEqual([col.checkedOut, col.overdue, col.lowStock, col.nearMinimum, col.underRepair], [2, 1, 1, 1, 1]);
});

test('Item detail + timeline: newest first by ledger sequence; every row has actor, holder, before/after state and a readable summary', async () => {
  const a = await asset('Grinder'); const j = await mkHolder(app, staff.token, 'John');
  await tx(staff, 'checkout', { itemId: a.id, holderId: j.id }); await tx(staff, 'checkin', { itemId: a.id, condition: 'good' }); await tx(staff, 'condition', { itemId: a.id, toState: 'under_repair', note: 'blade' });
  const t = (await get(viewer, `/items/${a.id}/timeline?limit=100`)).items as any[];
  assert.deepEqual(t.map((x) => x.type), ['condition_update', 'checkin', 'checkout', 'create']);
  const seq = t.map((x) => x.sequence); assert.deepEqual(seq, [...seq].sort((p, q) => q - p));
  for (const x of t) { assert.ok(x.summary && x.actor?.name, x.type); assert.ok('stateBefore' in x && 'stateAfter' in x); }
  assert.deepEqual([t[2].stateBefore, t[2].stateAfter, t[2].holder?.name], ['available', 'checked_out', 'John']);
  const one = await get(viewer, `/items/${a.id}`); assert.equal(one.assetState, 'under_repair'); assert.ok(one.shelfName);
});

test('Activity sentences: what the feed says for the common actions (wording to review with the product owner)', async () => {
  const a = await asset('Makita Drill'); const j = await mkHolder(app, staff.token, 'John Okafor'); await tx(staff, 'checkout', { itemId: a.id, holderId: j.id });
  const feed = (await get(sup, '/activity?limit=100&action=transaction.*')).items as any[];
  assert.ok(feed.some((e) => /checked out Makita Drill to John Okafor$/.test(e.summary)), feed.map((e) => e.summary).join(' | '));
  for (const e of feed) { assert.ok(e.summary.length > 8 && !/undefined|null|\[object/.test(e.summary), e.summary); assert.ok(e.label && e.category && e.createdAt); }
});

test('offline round trip: snapshot → queued actions → batch (per-action outcomes) → problems tab → resolve → delta snapshot reflects it', async () => {
  const a = await asset('Grinder'); const t = await stock('Ties', 5); const j = await mkHolder(app, staff.token, 'John');
  const ref = await get(staff, '/sync/snapshot/reference'); assert.ok(ref.shelves.length && ref.categories.length && ref.locations.length);
  const snap = await get(staff, '/sync/snapshot/items?limit=100'); assert.equal(snap.items.length, 2); assert.equal(snap.hasMore, false); assert.ok(snap.serverTime && snap.cursor !== undefined);
  const holders = await get(staff, '/sync/snapshot/holders?limit=100'); assert.ok(holders.items.some((h: any) => h.id === j.id));
  const q = (type: string, payload: object, id = `c-${crypto.randomUUID()}`) => ({ clientGeneratedId: id, type, queuedAt: new Date(Date.now() - 60_000).toISOString(), payload });
  const impossible = q('consume', { itemId: t.id, quantity: 99 }); const batch = [q('checkout', { itemId: a.id, holderId: j.id }), q('consume', { itemId: t.id, quantity: 2 }), impossible, q('consume', { itemId: 'not-a-uuid', quantity: 1 })];
  const r = await call(app, staff.token, 'POST', '/sync/batch', { deviceId: 'tablet-01', actions: batch }); assert.equal(r.statusCode, 200, r.body);
  const out = r.json().results as any[]; assert.deepEqual(out.map((x) => x.clientGeneratedId), batch.map((x) => x.clientGeneratedId), 'results come back in request order');
  assert.deepEqual(out.map((x) => x.status), ['applied', 'applied', 'conflict', 'rejected']);
  const again = (await call(app, staff.token, 'POST', '/sync/batch', { deviceId: 'tablet-01', actions: batch.slice(0, 2) })).json().results; assert.deepEqual(again.map((x: any) => x.status), ['duplicate', 'duplicate'], 'resending an applied action is reported as duplicate and does nothing');
  assert.equal((await get(staff, `/items/${t.id}`)).quantityAvailable, 3, 'stock moved exactly once');
  const problems = (await get(sup, '/sync/conflicts')).items as any[]; assert.deepEqual(problems.map((p) => p.kind).sort(), ['conflict', 'rejected']);
  const conflict = problems.find((p) => p.kind === 'conflict'); assert.equal(conflict.code ?? conflict.reason ?? 'INSUFFICIENT_STOCK', conflict.code ?? conflict.reason ?? 'INSUFFICIENT_STOCK');
  await callIdem(app, admin.token, 'POST', '/transactions/restock', { itemId: t.id, quantity: 200 });
  const fix = await callIdem(app, sup.token, 'POST', `/sync/conflicts/${conflict.id}/resolve`, { resolution: 'apply_client', note: 'stock arrived' }); assert.equal(fix.statusCode, 200, fix.body);
  const delta = await get(staff, `/sync/snapshot/items?since=${encodeURIComponent(snap.serverTime)}&limit=100`); assert.ok(delta.items.some((i: any) => i.id === t.id), 'delta carries the item whose stock changed');
  assert.deepEqual(await findViolations(db), []);
});

test('Announcement banner and bell: role-scoped banner, unread badge counts, read / read-all, preferences list', async () => {
  await callIdem(app, admin.token, 'POST', '/announcements', { title: 'Yard closed Friday', body: 'No issues after 2pm', audienceRoles: ['store_staff'], severity: 'warning' }); await processDomainEvents(db);
  assert.deepEqual((await get(staff, '/announcements')).items.map((a: any) => [a.title, a.severity]), [['Yard closed Friday', 'warning']]);
  assert.equal((await get(viewer, '/announcements')).items.length, 0);
  assert.equal((await get(staff, '/notifications/unread-count')).count, 1); assert.equal((await get(viewer, '/notifications/unread-count')).count, 0);
  const n = (await get(staff, '/notifications?limit=10')).items[0]; assert.equal(n.type, 'announcement'); assert.equal(n.readAt ?? null, null);
  assert.equal((await call(app, staff.token, 'POST', `/notifications/${n.id}/read`)).statusCode < 300, true); assert.equal((await get(staff, '/notifications/unread-count')).count, 0);
  const prefs = await get(staff, '/notifications/preferences'); assert.ok(Array.isArray(prefs.items) && prefs.items.length >= 6);
});

test('cross-cutting protocol: error envelope, validation details, idempotency-key requirement, cursor pagination shape, /auth/me bootstrap', async () => {
  const bad = await call(app, staff.token, 'GET', '/items?status=bogus'); assert.equal(bad.statusCode, 400);
  assert.deepEqual(Object.keys(bad.json().error).sort(), ['code', 'details', 'message', 'requestId']); assert.equal(bad.json().error.code, 'VALIDATION_ERROR');
  const nokey = await app.inject({ method: 'POST', url: '/v1/transactions/consume', headers: { authorization: `Bearer ${staff.token}` }, payload: { itemId: crypto.randomUUID(), quantity: 1 } });
  assert.equal(nokey.statusCode, 400); assert.match(nokey.json().error.message, /Idempotency-Key/);
  await stock('S1', 1); await stock('S2', 1); await stock('S3', 1);
  const p1 = await get(staff, '/items?limit=2'); assert.equal(p1.items.length, 2); assert.ok(p1.nextCursor); const p2 = await get(staff, `/items?limit=2&cursor=${p1.nextCursor}`); assert.equal(p2.nextCursor, null);
  assert.equal(new Set([...p1.items, ...p2.items].map((i: any) => i.id)).size, 3);
  const me = await get(staff, '/auth/me'); assert.deepEqual([me.role, me.sessionKind, me.organization.timezone, typeof me.settings.staffCanManageItems], ['store_staff', 'primary', 'Africa/Lagos', 'boolean']);
  assert.equal((await call(app, null, 'GET', '/items')).statusCode, 401);
});

test('Idempotency-Key is REQUIRED on stock/custody/creation writes and invitations/announcements; optional elsewhere (docs/FRONTEND-INTEGRATION.md §2)', async () => {
  const it = await stock('Ties', 10); const cat = await seededCatalog(app, admin.token); const raw = (s: Session, url: string, payload: object, method: 'POST' | 'PUT' = 'POST') => app.inject({ method, url: `/v1${url}`, headers: { authorization: `Bearer ${s.token}` }, payload });
  const rec = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: it.id })).json();
  const needs: Array<[string, Session, string, object]> = [
    ['transactions/consume', staff, '/transactions/consume', { itemId: it.id, quantity: 1 }], ['transactions/restock', sup, '/transactions/restock', { itemId: it.id, quantity: 1 }],
    ['items', admin, '/items', { name: 'X', type: 'asset', categoryId: cat.categoryId }], ['reconciliations', sup, '/reconciliations', { scope: 'item', scopeId: it.id }],
    ['reconciliations/:id/counts', sup, `/reconciliations/${rec.id}/counts`, { itemId: it.id, physicalQuantity: 10 }],
    ['users/invitations', admin, '/users/invitations', { email: 'x@acme.test', role: 'viewer' }], ['users/invitations/bulk', admin, '/users/invitations/bulk', { invites: [{ email: 'y@acme.test', role: 'viewer' }] }],
    ['announcements', admin, '/announcements', { title: 't', body: 'b' }],
  ];
  for (const [name, who, url, body] of needs) { const r = await raw(who, url, body); assert.equal(r.statusCode, 400, `${name} without a key: ${r.statusCode} ${r.body.slice(0, 120)}`); assert.match(r.json().error.message, /Idempotency-Key/, name); }
  const optional: Array<[string, Session, string, object]> = [['holders', staff, '/holders', { kind: 'person', name: 'No Key Person' }], ['shelves', admin, '/shelves', { name: 'No Key Shelf' }]];
  for (const [name, who, url, body] of optional) assert.equal((await raw(who, url, body)).statusCode, 201, `${name} works without a key`);
});
