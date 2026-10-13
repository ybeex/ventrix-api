import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkCategory, mkItem, mkHolder, idem, type App, type Session } from './helpers.js';

let app: App;
let admin: Session, sup: Session, staff: Session, viewer: Session;
let john: { id: string };
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app);
  admin = await registerOrg(app);
  sup = await createUser(app, admin, 'supervisor');
  staff = await createUser(app, admin, 'store_staff', 'Stella Staff');
  viewer = await createUser(app, admin, 'viewer');
  john = await mkHolder(app, staff.token, 'John Okafor');
});

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const get = async (token: string, url: string) => (await call(app, token, 'GET', url)).json();
const act = (type: string, payload: object, queuedAt = new Date().toISOString(), clientGeneratedId = `c-${crypto.randomUUID()}`) => ({ clientGeneratedId, type, queuedAt, payload });
const batch = (token: string, deviceId: string, actions: object[]) => call(app, token, 'POST', '/sync/batch', { deviceId, actions });
const qty = async (id: string) => (await get(admin.token, `/items/${id}`)).quantityAvailable;
const integrity = async () => assert.deepEqual(await findViolations(db), []);

test('a batch applies in queue order with the DEVICE time recorded separately from the SERVER time; actor is the authenticated user', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 20 });
  const drill = await mkItem(app, admin.token, { type: 'asset' });
  const earlier = new Date(Date.now() - 2 * 3600_000).toISOString();
  const r = await batch(staff.token, 'tablet-01', [
    act('checkout', { itemId: drill.id, holderId: john.id }, earlier),
    act('consume', { itemId: cons.id, quantity: 3 }, earlier),
    act('checkin', { itemId: drill.id, condition: 'good' }, new Date().toISOString()),
  ]);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().results.map((x: any) => x.status), ['applied', 'applied', 'applied']);
  assert.equal(await qty(cons.id), 17);
  assert.equal((await get(admin.token, `/items/${drill.id}`)).assetState, 'available');

  const t = (await get(admin.token, `/transactions/${r.json().results[0].transactionId}`));
  assert.equal(t.source, 'sync');
  assert.equal(t.deviceId, 'tablet-01');
  assert.equal(t.actor.id, staff.userId);
  assert.ok(Math.abs(new Date(t.occurredAt).getTime() - new Date(earlier).getTime()) < 1000, 'device time preserved');
  assert.ok(Date.now() - new Date(t.createdAt).getTime() < 60_000, 'server receive time is authoritative and separate');
  const timeline = (await get(admin.token, `/items/${drill.id}/timeline`)).items;
  assert.deepEqual(timeline.map((x: any) => x.type), ['checkin', 'checkout', 'create'], 'timeline order is the server ledger order');
  await integrity();
});

test('REPLAY SAFETY: re-sending a batch (lost response, app restart) never duplicates or loses anything', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 50 });
  const actions = [act('consume', { itemId: cons.id, quantity: 5 }), act('restock', { itemId: cons.id, quantity: 2 }), act('consume', { itemId: cons.id, quantity: 1 })];
  const first = (await batch(staff.token, 'tablet-01', actions)).json().results;
  const again = (await batch(staff.token, 'tablet-01', actions)).json().results;
  assert.deepEqual(again.map((x: any) => x.status), ['duplicate', 'duplicate', 'duplicate']);
  assert.deepEqual(again.map((x: any) => x.transactionId), first.map((x: any) => x.transactionId));
  assert.equal(await qty(cons.id), 46);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from transactions where source = 'sync'`))[0].n, 3);
  // the same client id with a DIFFERENT payload is a client bug, not a replay
  const tampered = await batch(staff.token, 'tablet-01', [{ ...actions[0], payload: { itemId: cons.id, quantity: 9 } }]);
  assert.equal(tampered.json().results[0].status, 'rejected');
  assert.equal(tampered.json().results[0].code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await qty(cons.id), 46);
  // another device may reuse the same client id: ids are scoped to (device)
  assert.equal((await batch(staff.token, 'tablet-02', [actions[0]])).json().results[0].status, 'applied');
  assert.equal(await qty(cons.id), 41);
  await integrity();
});

test('10 concurrent copies of the same batch apply it exactly once', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 100 });
  const actions = [act('consume', { itemId: cons.id, quantity: 4 }), act('consume', { itemId: cons.id, quantity: 6 })];
  const res = await Promise.all(Array.from({ length: 10 }, () => batch(staff.token, 'tablet-01', actions)));
  assert.ok(res.every((r) => r.statusCode === 200));
  assert.equal(await qty(cons.id), 90);
  assert.equal(res.flatMap((r) => r.json().results).filter((x: any) => x.status === 'applied').length, 2);
  await integrity();
});

test('CONFLICTS: one poison action never blocks the rest; the conflict is stored ONCE, however often it is re-sent', async () => {
  const last = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 1, name: 'Last unit' });
  const other = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  await call(app, admin.token, 'POST', '/transactions/consume', { itemId: last.id, quantity: 1 }, { 'idempotency-key': idem() }); // the server moved on while the device was offline
  const actions = [act('consume', { itemId: last.id, quantity: 1 }), act('consume', { itemId: other.id, quantity: 2 })];
  const r1 = (await batch(staff.token, 'tablet-01', actions)).json().results;
  assert.deepEqual(r1.map((x: any) => x.status), ['conflict', 'applied'], 'the action behind the conflict still went through');
  assert.equal(r1[0].code, 'INSUFFICIENT_STOCK');
  await batch(staff.token, 'tablet-01', actions);
  await batch(staff.token, 'tablet-01', actions);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from sync_issues`))[0].n, 1, 'no duplicate issue rows on retry');
  assert.equal(rows(await db.execute(sql`select count(*)::int n from domain_events where type = 'sync.issue'`))[0].n, 1, 'and no duplicate notifications');
  assert.equal(await qty(other.id), 8);
  assert.equal((await get(sup.token, '/dashboard')).openSyncIssues, 1);
  await integrity();
});

test('rejected actions: bad payloads, unknown operations, other-org items and duplicate ids; viewers cannot push', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const other = await registerOrg(app, 'Rival');
  const theirs = await mkItem(app, other.token, { type: 'consumable', openingQuantity: 10 });
  const r = (await batch(staff.token, 'tablet-01', [
    act('consume', { itemId: cons.id, quantity: 1, stockDelta: 99 }),
    act('teleport', { itemId: cons.id }),
    act('consume', { itemId: 'not-a-uuid', quantity: 1 }),
    act('consume', { itemId: theirs.id, quantity: 1 }),
    act('consume', { itemId: cons.id, quantity: 2 }),
  ])).json().results;
  assert.deepEqual(r.map((x: any) => x.status), ['rejected', 'rejected', 'rejected', 'rejected', 'applied']);
  assert.deepEqual(r.map((x: any) => x.code), ['VALIDATION_ERROR', 'UNKNOWN_OPERATION', 'VALIDATION_ERROR', 'NOT_FOUND', undefined]);
  assert.equal(await qty(cons.id), 8);
  assert.equal((await get(other.token, `/items/${theirs.id}`)).quantityAvailable, 10, "another tenant's stock is untouchable");
  const dup = act('consume', { itemId: cons.id, quantity: 1 });
  assert.equal((await batch(staff.token, 'tablet-01', [dup, dup])).statusCode, 400);
  assert.equal((await batch(viewer.token, 'tablet-01', [dup])).statusCode, 403);
  assert.equal((await call(app, staff.token, 'POST', '/sync/batch', { deviceId: 'tablet-01', actions: [] })).statusCode, 400);
  assert.equal((await call(app, staff.token, 'POST', '/sync/batch', { deviceId: 'x', actions: [dup] })).statusCode, 400);
});

test('a retry that now succeeds closes its own open issue automatically', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 0 });
  const a = act('consume', { itemId: cons.id, quantity: 5 });
  assert.equal((await batch(staff.token, 'tablet-01', [a])).json().results[0].status, 'conflict');
  assert.equal((await get(sup.token, '/sync/conflicts')).items.length, 1);
  await call(app, sup.token, 'POST', '/transactions/restock', { itemId: cons.id, quantity: 10 }, { 'idempotency-key': idem() });
  assert.equal((await batch(staff.token, 'tablet-01', [a])).json().results[0].status, 'applied');
  assert.equal((await get(sup.token, '/sync/conflicts')).items.length, 0);
  const done = (await get(sup.token, '/sync/conflicts?status=resolved')).items[0];
  assert.deepEqual([done.status, done.resolutionNote], ['resolved_applied_client', 'Applied automatically on retry']);
  assert.equal(await qty(cons.id), 5);
});

test('conflict review: keep_server / apply_client (as the ORIGINAL person); refused while still impossible; staff cannot review', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 0 });
  const a = act('consume', { itemId: cons.id, quantity: 4 }, undefined, 'conflict-A-0001');
  const b = act('consume', { itemId: cons.id, quantity: 1 }, undefined, 'conflict-B-0001');
  await batch(staff.token, 'tablet-01', [a, b]);
  assert.equal((await call(app, staff.token, 'GET', '/sync/conflicts')).statusCode, 403);
  const issues = (await get(sup.token, '/sync/conflicts')).items;
  assert.equal(issues.length, 2);
  const issueA = issues.find((i: any) => i.clientGeneratedId === 'conflict-A-0001');
  const issueB = issues.find((i: any) => i.clientGeneratedId === 'conflict-B-0001');
  assert.deepEqual([issueA.actor.name, issueA.code, issueA.deviceId], ['Stella Staff', 'INSUFFICIENT_STOCK', 'tablet-01']);
  assert.equal((await call(app, staff.token, 'POST', `/sync/conflicts/${issueA.id}/resolve`, { resolution: 'keep_server', note: 'x' })).statusCode, 403);

  const still = await call(app, sup.token, 'POST', `/sync/conflicts/${issueA.id}/resolve`, { resolution: 'apply_client', note: 'Try it' });
  assert.equal(still.statusCode, 409);
  assert.equal(still.json().error.code, 'INSUFFICIENT_STOCK', 'the same rules apply: nothing is forced through');
  assert.equal((await get(sup.token, '/sync/conflicts')).items.length, 2, 'both issues remain open');

  const kept = await call(app, sup.token, 'POST', `/sync/conflicts/${issueB.id}/resolve`, { resolution: 'keep_server', note: 'Item was already used up' });
  assert.deepEqual([kept.statusCode, kept.json().status, kept.json().resolvedBy], [200, 'resolved_kept_server', sup.userId]);
  assert.equal((await call(app, sup.token, 'POST', `/sync/conflicts/${issueB.id}/resolve`, { resolution: 'keep_server', note: 'again' })).json().error.code, 'ISSUE_RESOLVED');

  await call(app, sup.token, 'POST', '/transactions/restock', { itemId: cons.id, quantity: 10 }, { 'idempotency-key': idem() });
  const applied = await call(app, sup.token, 'POST', `/sync/conflicts/${issueA.id}/resolve`, { resolution: 'apply_client', note: 'Confirmed with Stella' });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().status, 'resolved_applied_client');
  const t = await get(admin.token, `/transactions/${applied.json().resultingTransactionId}`);
  assert.deepEqual([t.actor.id, t.source, t.deviceId], [staff.userId, 'sync', 'tablet-01'], 'the ledger names who actually did it, not the reviewer');
  assert.equal(await qty(cons.id), 6);
  await integrity();
});

test('apply_client is refused when the original person has since been deactivated', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 0 });
  await batch(staff.token, 'tablet-01', [act('consume', { itemId: cons.id, quantity: 1 })]);
  const issue = (await get(sup.token, '/sync/conflicts')).items[0];
  await call(app, admin.token, 'PATCH', `/users/${staff.userId}`, { active: false });
  const r = await call(app, sup.token, 'POST', `/sync/conflicts/${issue.id}/resolve`, { resolution: 'apply_client', note: 'x' });
  assert.equal(r.json().error.code, 'ACTOR_INACTIVE');
});

test('approval policy applies to queued actions exactly as online (and replays stay pending, never doubled)', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const a = act('adjustment', { itemId: cons.id, quantityDelta: -3, reason: 'count_correction' });
  const r1 = (await batch(staff.token, 'tablet-01', [a])).json().results[0];
  assert.equal(r1.status, 'pending_approval');
  const r2 = (await batch(staff.token, 'tablet-01', [a])).json().results[0];
  assert.deepEqual([r2.status, r2.approvalId], ['pending_approval', r1.approvalId]);
  assert.equal(await qty(cons.id), 10);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from pending_approvals`))[0].n, 1);
});

test('device clocks are not trusted: future and absurdly old timestamps are clamped; plausible ones are kept', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 100 });
  const day = 86_400_000;
  const mk = (when: Date) => act('consume', { itemId: cons.id, quantity: 1 }, when.toISOString());
  const r = (await batch(staff.token, 'tablet-01', [mk(new Date(Date.now() + day)), mk(new Date(Date.now() - 60 * day)), mk(new Date(Date.now() - 3600_000))])).json().results;
  const at = async (i: number) => new Date((await get(admin.token, `/transactions/${r[i].transactionId}`)).occurredAt).getTime();
  assert.ok(Math.abs((await at(0)) - Date.now()) < 60_000, 'a clock set to tomorrow is clamped to now');
  assert.ok(Math.abs((await at(1)) - Date.now()) < 60_000, 'a 60-day-old queue is clamped to now');
  assert.ok(Math.abs((await at(2)) - (Date.now() - 3600_000)) < 60_000, 'an hour-old action keeps its time');
});

test('delta snapshots: full first pull, then only what changed (archived included); cursor resumes; pagination; reference data', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Fasteners' });
  const a = await mkItem(app, admin.token, { type: 'consumable', name: 'A', openingQuantity: 5, categoryId: cat.id });
  const b = await mkItem(app, admin.token, { type: 'asset', name: 'B' });
  const c = await mkItem(app, admin.token, { type: 'consumable', name: 'C', openingQuantity: 5 });

  const full = await get(viewer.token, '/sync/snapshot/items?limit=2');
  assert.equal(full.items.length, 2);
  assert.equal(full.hasMore, true);
  const rest = await get(viewer.token, `/sync/snapshot/items?limit=2&cursor=${encodeURIComponent(full.cursor)}`);
  const all = [...full.items, ...rest.items.filter((i: any) => !full.items.some((x: any) => x.id === i.id))];
  assert.deepEqual(all.map((i: any) => i.name).sort(), ['A', 'B', 'C']);
  assert.equal(rest.hasMore, false);

  const idle = await get(viewer.token, `/sync/snapshot/items?cursor=${encodeURIComponent(rest.cursor)}`);
  assert.equal(idle.items.filter((i: any) => ![a.id, b.id, c.id].includes(i.id)).length, 0);
  await new Promise((r) => setTimeout(r, 20));
  await call(app, staff.token, 'POST', '/transactions/consume', { itemId: a.id, quantity: 2 }, { 'idempotency-key': idem() });
  await call(app, admin.token, 'POST', `/items/${c.id}/archive`);
  const delta = await get(viewer.token, `/sync/snapshot/items?cursor=${encodeURIComponent(rest.cursor)}`);
  const changed = Object.fromEntries(delta.items.map((i: any) => [i.name, i]));
  assert.equal(changed.A.quantityAvailable, 3, 'stock change appears in the delta');
  assert.ok(changed.C.archivedAt, 'archived items are included so the device can retire them');
  assert.equal(changed.B, undefined, 'untouched items are not resent');

  const hs = await get(viewer.token, '/sync/snapshot/holders');
  assert.ok(hs.items.some((h: any) => h.name === 'John Okafor'));
  const ref = await get(viewer.token, '/sync/snapshot/reference');
  assert.deepEqual([ref.categories.map((x: any) => x.name).sort(), ref.locations.length, typeof ref.settings.dueSoonHours], [['Fasteners', 'General'], 1, 'number']);
  assert.equal((await call(app, viewer.token, 'GET', '/sync/snapshot/items?cursor=garbage')).statusCode, 400);
  const other = await registerOrg(app, 'Rival');
  assert.equal((await get(other.token, '/sync/snapshot/items')).items.length, 0, 'snapshots never leak across tenants');
  const theirs = await get(other.token, '/sync/snapshot/reference');
  assert.deepEqual(theirs.categories.map((x: any) => x.name), ['General'], 'only their own seeded category — none of mine');
  assert.ok(theirs.categories.every((c: any) => c.id !== cat.id) && theirs.shelves.every((sh: any) => sh.orgId !== admin.orgId));
});

test('metrics: sync outcomes are exported (applied / replayed / conflict / rejected)', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 1 });
  const ok = act('consume', { itemId: cons.id, quantity: 1 });
  await batch(staff.token, 'tablet-01', [ok, act('consume', { itemId: cons.id, quantity: 1 }), act('nope', {})]);
  await batch(staff.token, 'tablet-01', [ok]);
  const body = (await app.inject('/metrics')).body;
  for (const o of ['applied', 'replayed', 'conflict', 'rejected']) assert.match(body, new RegExp(`storekeeper_sync_actions_total\\{outcome="${o}"\\}`), o);
  void callIdem;
});
