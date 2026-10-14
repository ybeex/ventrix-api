/** Activity feed: human summaries, category/action filters, catalogue completeness, tenant-scoped entity names, read logging (first page only). */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { AUDIT_ACTIONS } from '../src/lib/audit-catalog.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, mkItem, mkHolder, mkShelf, mkCategory, auditCount, idem, PASSWORD, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session, viewer: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app); admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor', 'Sam Supervisor'); staff = await createUser(app, admin, 'store_staff', 'Stella Staff'); viewer = await createUser(app, admin, 'viewer');
});

const feed = async (q = '', token = admin.token) => (await call(app, token, 'GET', `/activity?limit=100${q}`)).json().items as any[];
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const tx = (token: string, op: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/transactions/${op}`, body, key);
const one = async (action: string, filterFn: (e: any) => boolean = () => true) => { const e = (await feed(`&action=${action}`)).find(filterFn); assert.ok(e, `no ${action} event`); return e; };

test('ledger summaries read as sentences for every transaction type', async () => {
  const john = await mkHolder(app, staff.token, 'John Okafor');
  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Makita Drill' });
  const ties = await mkItem(app, admin.token, { type: 'consumable', name: 'Cable ties', openingQuantity: 50, minQuantity: 5 });
  await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id });
  await tx(staff.token, 'checkin', { itemId: drill.id });
  await tx(staff.token, 'consume', { itemId: ties.id, quantity: 4, holderId: john.id });
  await tx(staff.token, 'restock', { itemId: ties.id, quantity: 20 });
  await tx(admin.token, 'adjust', { itemId: ties.id, quantityDelta: -3, reason: 'count_correction' });
  await callIdem(app, admin.token, 'POST', `/items/${drill.id}/archive`, {}); await callIdem(app, admin.token, 'POST', `/items/${drill.id}/restore`, {});
  const s = async (type: string) => (await one(`transaction.${type}`)).summary as string;
  assert.equal(await s('checkout'), 'Stella Staff checked out Makita Drill to John Okafor');
  assert.equal(await s('checkin'), 'Stella Staff returned Makita Drill from John Okafor');
  assert.equal(await s('consume'), 'Stella Staff used 4 Cable ties for John Okafor');
  assert.equal(await s('restock'), 'Stella Staff added 20 Cable ties to stock');
  assert.equal(await s('adjustment'), 'Ada Admin adjusted Cable ties by -3 (count correction)');
  assert.equal(await s('archive'), 'Ada Admin archived Makita Drill'); assert.equal(await s('restore'), 'Ada Admin restored Makita Drill');
  const created = (await feed('&action=transaction.create')).map((e) => e.summary as string);
  assert.ok(created.includes('Ada Admin added Cable ties to the catalogue with 50 in stock'), created.join(' | '));
  assert.ok(created.includes('Ada Admin added Makita Drill to the catalogue'));
});

test('loss, damage, condition changes, counts and corrections read correctly', async () => {
  const john = await mkHolder(app, staff.token, 'John Okafor');
  const saw = await mkItem(app, admin.token, { type: 'asset', name: 'Circular Saw' }); const bits = await mkItem(app, admin.token, { type: 'consumable', name: 'Drill bits', openingQuantity: 20 });
  const co = await tx(staff.token, 'checkout', { itemId: saw.id, holderId: john.id }); assert.equal(co.statusCode, 201);
  const lost = await tx(admin.token, 'loss', { itemId: saw.id, note: 'Fell off the truck' });
  assert.equal(lost.statusCode, 201, lost.body);
  assert.equal((await one('transaction.loss')).summary, 'Ada Admin declared Circular Saw lost while with John Okafor');
  const dmg = await tx(admin.token, 'damage', { itemId: bits.id, quantity: 2, note: 'Snapped' }); assert.equal(dmg.statusCode, 201, dmg.body);
  assert.equal((await one('transaction.damage')).summary, 'Ada Admin wrote off 2 Drill bits as damaged');
  const rec = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: bits.id })).json();
  await callIdem(app, sup.token, 'POST', `/reconciliations/${rec.id}/counts`, { itemId: bits.id, physicalQuantity: 18 });
  assert.equal((await one('transaction.reconciliation')).summary, 'Sam Supervisor counted Drill bits: 18 found, 18 expected');
  const wrong = (await tx(staff.token, 'consume', { itemId: bits.id, quantity: 1 })).json().transaction.id;
  await tx(admin.token, `${wrong}/correct`, { note: 'oops' });
  assert.equal((await one('transaction.correction')).summary, 'Ada Admin corrected an earlier entry on Drill bits');
});

test('audit-backed summaries for people, structure, settings, security and reporting', async () => {
  await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'new.hire@acme.test', role: 'store_staff' });
  await call(app, admin.token, 'PATCH', `/users/${viewer.userId}`, { role: 'supervisor' });
  const shelf = await mkShelf(app, admin.token, { name: 'Yard rack' }); const cat = await mkCategory(app, admin.token, { shelfId: shelf.id, name: 'Chains' });
  await callIdem(app, admin.token, 'POST', '/announcements', { title: 'Yard closed', body: 'Friday' });
  await call(app, admin.token, 'PUT', '/organization/notification-rules/low_stock', { roles: ['viewer'] });
  await call(app, admin.token, 'PATCH', '/organization/settings', { nearMinimumPercent: 20 });
  await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: admin.slug, email: staff.email, password: 'wrong-wrong-wrong-1' } });
  await call(app, staff.token, 'POST', '/shelves', { name: 'nope' });
  await call(app, admin.token, 'GET', '/reports/inventory');
  void cat;
  const sum = async (a: string, f?: (e: any) => boolean) => (await one(a, f)).summary as string;
  assert.equal(await sum('user.invited'), 'Ada Admin invited new.hire@acme.test as store staff');
  assert.match(await sum('user.role_changed'), /^Ada Admin changed .+'s role from viewer to supervisor$/);
  assert.equal(await sum('shelf.created', (e) => e.entity.name === 'Yard rack'), 'Ada Admin created shelf Yard rack');
  assert.equal(await sum('category.created', (e) => e.entity.name === 'Chains'), 'Ada Admin created category Chains');
  assert.equal(await sum('announcement.published'), 'Ada Admin published the announcement "Yard closed"');
  assert.equal(await sum('notification.rules_changed'), 'Ada Admin changed who receives "low stock" notifications');
  assert.equal(await sum('settings.updated'), 'Ada Admin changed organization settings');
  assert.match(await sum('auth.login_failed'), /^Failed sign-in for Stella Staff \(bad password\)$/);
  assert.equal(await sum('access.denied'), 'Stella Staff was refused access to "shelves:manage"');
  assert.equal(await sum('report.viewed'), 'Ada Admin viewed the inventory report');
});

test('session.revoked says WHOSE session was signed out (own device vs an admin acting on someone else)', async () => {
  const t2 = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: admin.slug, email: staff.email, password: PASSWORD } })).json().token;
  const other = (await call(app, t2, 'GET', '/auth/sessions')).json().items.find((i: any) => !i.current);
  await call(app, t2, 'DELETE', `/auth/sessions/${other.id}`);
  await call(app, admin.token, 'DELETE', `/users/${staff.userId}/sessions`);
  const evs = await feed('&action=session.revoked');
  const own = evs.find((e) => e.actor.id === staff.userId)!.summary as string; const byAdmin = evs.find((e) => e.actor.id === admin.userId)!.summary as string;
  assert.equal(own, 'Stella Staff signed out one of their own devices');
  assert.match(byAdmin, /^Ada Admin signed out Stella Staff everywhere \(\d+ sessions?\)$/);
});

test('unknown actions fall back safely: generic sentence, "Other" category, humanised label — never an error', async () => {
  await db.execute(sql`insert into audit_events (org_id, actor_user_id, action, entity_type, entity_id) values (${admin.orgId}, ${admin.userId}, 'legacy.thing_happened', 'widget', 'w-1')`);
  const e = (await feed('&action=legacy.thing_happened'))[0];
  assert.equal(e.category, 'Other'); assert.equal(e.label, 'legacy thing happened'); assert.equal(e.summary, 'Ada Admin: legacy thing happened'); assert.equal(e.entity.name, null);
});

test('GET /activity/actions lists every registered action with label and category, and every category used', async () => {
  const r = (await call(app, admin.token, 'GET', '/activity/actions')).json();
  assert.deepEqual(r.items.map((i: any) => i.action).sort(), Object.keys(AUDIT_ACTIONS).sort());
  assert.ok(r.items.every((i: any) => i.label && r.categories.includes(i.category)));
  assert.deepEqual([...r.categories].sort(), [...new Set(Object.values(AUDIT_ACTIONS).map((v) => v.category))].sort());
});

test('category filter returns only that category; an unknown category returns nothing; action filter supports exact and "prefix.*"', async () => {
  const john = await mkHolder(app, staff.token, 'John'); const it = await mkItem(app, admin.token, { type: 'asset', name: 'Drill' });
  await tx(staff.token, 'checkout', { itemId: it.id, holderId: john.id }); await call(app, staff.token, 'POST', '/shelves', { name: 'x' });
  const sec = await feed('&category=Security'); assert.ok(sec.length > 0 && sec.every((e) => AUDIT_ACTIONS[e.action]?.category === 'Security'));
  const inv = await feed('&category=Inventory'); assert.ok(inv.length > 0 && inv.every((e) => e.category === 'Inventory'));
  assert.deepEqual(await feed('&category=Nonsense'), []);
  const txs = await feed('&action=transaction.*'); assert.ok(txs.length > 0 && txs.every((e) => e.action.startsWith('transaction.')));
  assert.ok((await feed('&action=auth.*')).every((e) => e.action.startsWith('auth.')));
  assert.equal((await feed('&action=transaction.checkout')).length, 1);
  for (const bad of ['Transaction.checkout', 'a%b', 'x;drop', 'a b']) assert.equal((await call(app, admin.token, 'GET', `/activity?action=${encodeURIComponent(bad)}`)).statusCode, 400, bad);
});

test('entity names resolve for the caller’s organization only — another tenant’s id never leaks a name', async () => {
  const rival = await registerOrg(app, 'Rival'); const theirs = await mkItem(app, rival.token, { type: 'asset', name: 'Rival Secret Drill' });
  await db.execute(sql`insert into audit_events (org_id, actor_user_id, action, entity_type, entity_id) values (${admin.orgId}, ${admin.userId}, 'item.updated', 'item', ${theirs.id})`);
  const e = (await feed('&action=item.updated'))[0]; assert.equal(e.entity.name, null); assert.ok(!JSON.stringify(e).includes('Rival Secret'));
  const mine = await mkItem(app, admin.token, { type: 'asset', name: 'My Drill' }); await call(app, admin.token, 'PATCH', `/items/${mine.id}`, { description: 'x' });
  assert.equal((await feed(`&entityId=${mine.id}&action=item.updated`))[0].entity.name, 'My Drill');
  assert.ok(!(await feed()).some((x) => JSON.stringify(x).includes('Rival Secret')));
});

test('sequence paging: every event exactly once, newest first, across pages', async () => {
  for (let i = 0; i < 6; i++) await mkShelf(app, admin.token, { name: `Shelf ${i}` });
  const all = await feed(); const seen: number[] = []; let cursor: string | null = null;
  do { const p: any = (await call(app, admin.token, 'GET', `/activity?limit=4${cursor ? `&cursor=${cursor}` : ''}`)).json(); seen.push(...p.items.map((i: any) => i.sequence)); cursor = p.nextCursor; } while (cursor);
  assert.equal(new Set(seen).size, seen.length); assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  assert.ok(seen.length >= all.length, 'paging sees at least everything in the big page (plus the activity.viewed rows it generated)');
});

test('read logging: activity.viewed and report.viewed are written ONCE per first page — paging and CSV do not add view rows; CSV logs report.exported', async () => {
  for (let i = 0; i < 5; i++) await mkShelf(app, admin.token, { name: `S${i}` });
  const v0 = await auditCount(admin.orgId, 'activity.viewed');
  const p1 = (await call(app, admin.token, 'GET', '/activity?limit=2')).json(); assert.equal(await auditCount(admin.orgId, 'activity.viewed'), v0 + 1);
  await call(app, admin.token, 'GET', `/activity?limit=2&cursor=${p1.nextCursor}`); await call(app, admin.token, 'GET', `/activity?limit=2&cursor=${p1.nextCursor}`);
  assert.equal(await auditCount(admin.orgId, 'activity.viewed'), v0 + 1, 'later pages are not views');
  const e0 = await auditCount(admin.orgId, 'report.exported'); const csv = await call(app, admin.token, 'GET', '/activity?format=csv');
  assert.equal(csv.statusCode, 200); assert.match(csv.headers['content-type'] as string, /text\/csv/); assert.equal(await auditCount(admin.orgId, 'activity.viewed'), v0 + 1); assert.equal(await auditCount(admin.orgId, 'report.exported'), e0 + 1);
  const r0 = await auditCount(admin.orgId, 'report.viewed'); const r1 = (await call(app, admin.token, 'GET', '/reports/transactions?limit=1')).json();
  assert.equal(await auditCount(admin.orgId, 'report.viewed'), r0 + 1);
  if (r1.nextCursor) { await call(app, admin.token, 'GET', `/reports/transactions?limit=1&cursor=${r1.nextCursor}`); assert.equal(await auditCount(admin.orgId, 'report.viewed'), r0 + 1); }
  const w = (await feed('&action=report.viewed'))[0]; assert.equal(w.entity.id, 'transactions'); assert.equal(w.actor.id, admin.userId);
});

test('access: reviewers read the feed; staff and viewers cannot (403, and a denial is logged)', async () => {
  assert.equal((await call(app, sup.token, 'GET', '/activity')).statusCode, 200);
  const d0 = await auditCount(admin.orgId, 'access.denied');
  for (const s of [staff, viewer]) { assert.equal((await call(app, s.token, 'GET', '/activity')).statusCode, 403); assert.equal((await call(app, s.token, 'GET', '/reports/inventory')).statusCode, 403); }
  assert.equal(await auditCount(admin.orgId, 'access.denied'), d0 + 4);
  const rival = await registerOrg(app, 'Rival'); assert.ok(!(await feed('', rival.token)).some((e) => e.actor?.id === admin.userId), 'tenant isolation');
});
