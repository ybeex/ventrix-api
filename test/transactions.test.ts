import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { items } from '../src/db/schema.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkCategory, mkItem, mkHolder, upload, idem, type App, type Session } from './helpers.js';

let app: App;
let admin: Session, sup: Session, staff: Session, viewer: Session;
let john: { id: string };
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app);
  admin = await registerOrg(app);
  sup = await createUser(app, admin, 'supervisor', 'Sam Supervisor');
  staff = await createUser(app, admin, 'store_staff', 'Stella Staff');
  viewer = await createUser(app, admin, 'viewer');
  john = await mkHolder(app, staff.token, 'John Okafor');
});

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const tx = (token: string, op: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/transactions/${op}`, body, key);
const item = async (id: string) => (await call(app, admin.token, 'GET', `/items/${id}`)).json();
const integrity = async () => assert.deepEqual(await findViolations(db), [], 'ledger integrity oracle');
const setPolicy = (over: object = {}) => call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'staff_approval', lossMode: 'staff_approval', retirementMode: 'staff_approval', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: null, ...over });

test('asset lifecycle: checkout → on site → check-in; actor and holder are different people; due date fixed at issue', async () => {
  const cat = await mkCategory(app, admin.token, { name: 'Drills', codePrefix: 'DRL', defaultExpectedReturnHours: 8 });
  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Makita Drill', categoryId: cat.id });
  const out = await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id, purpose: 'Install conduit' });
  assert.equal(out.statusCode, 201);
  const t = out.json().transaction;
  assert.equal(t.type, 'checkout');
  assert.equal(t.actor.id, staff.userId);
  assert.equal(t.holder.name, 'John Okafor');
  assert.notEqual(t.actor.id, t.holder.id);
  assert.equal(t.custodyDelta, 1);
  assert.deepEqual([t.stateBefore, t.stateAfter], ['available', 'checked_out']);
  const due = new Date(t.dueAt).getTime() - new Date(t.createdAt).getTime();
  assert.ok(Math.abs(due - 8 * 3600_000) < 5000, 'due = issue time + category default');
  const now = await item(drill.id);
  assert.equal(now.assetState, 'checked_out');
  assert.equal(now.currentHolder.name, 'John Okafor');
  assert.equal(now.dueStatus, 'due_soon', 'due in 8h is inside the 24h due-soon window');

  const back = await tx(staff.token, 'checkin', { itemId: drill.id, holderId: john.id, condition: 'good' });
  assert.equal(back.statusCode, 201);
  assert.deepEqual([back.json().transaction.stateBefore, back.json().transaction.stateAfter], ['checked_out', 'available']);
  const after = await item(drill.id);
  assert.equal(after.assetState, 'available');
  assert.equal(after.currentHolder, null);
  assert.equal(after.dueAt, null);
  await integrity();
});

test('a checked-out asset cannot be checked out again; 10 concurrent checkouts yield exactly one winner', async () => {
  const drill = await mkItem(app, admin.token, { type: 'asset' });
  const people = await Promise.all(Array.from({ length: 10 }, (_, i) => mkHolder(app, staff.token, `Worker ${i}`)));
  const res = await Promise.all(people.map((p) => tx(staff.token, 'checkout', { itemId: drill.id, holderId: p.id })));
  assert.equal(res.filter((r) => r.statusCode === 201).length, 1);
  const losers = res.filter((r) => r.statusCode !== 201);
  assert.ok(losers.every((r) => r.statusCode === 409 && r.json().error.code === 'ITEM_NOT_AVAILABLE'));
  assert.equal(rows(await db.execute(sql`select count(*)::int n from transactions where item_id = ${drill.id} and type = 'checkout'`))[0].n, 1);
  await integrity();
});

test('NEVER OVERSELL: 25 concurrent single-unit checkouts against 10 in stock → exactly 10 succeed, stock ends at 0, never negative', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const res = await Promise.all(Array.from({ length: 25 }, () => tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 1 })));
  assert.equal(res.filter((r) => r.statusCode === 201).length, 10);
  assert.ok(res.filter((r) => r.statusCode !== 201).every((r) => r.json().error.code === 'INSUFFICIENT_STOCK'));
  assert.equal((await item(cons.id)).quantityAvailable, 0);
  assert.equal((await call(app, admin.token, 'GET', '/transactions?type=checkout&limit=100')).json().items.length, 10);
  await integrity();
});

test('idempotency: replay → 200 + header, no second effect; key reused with a different body → 409; 10 concurrent duplicates → one transaction', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 100 });
  assert.equal((await call(app, staff.token, 'POST', '/transactions/consume', { itemId: cons.id, quantity: 1 })).statusCode, 400, 'key required');
  const key = idem();
  const a = await tx(staff.token, 'consume', { itemId: cons.id, quantity: 4 }, key);
  const b = await tx(staff.token, 'consume', { itemId: cons.id, quantity: 4 }, key);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 200);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(a.json().transaction.id, b.json().transaction.id);
  assert.equal((await item(cons.id)).quantityAvailable, 96);
  const diff = await tx(staff.token, 'consume', { itemId: cons.id, quantity: 5 }, key);
  assert.equal(diff.statusCode, 409);
  assert.equal(diff.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  const k2 = idem();
  const par = await Promise.all(Array.from({ length: 10 }, () => tx(staff.token, 'consume', { itemId: cons.id, quantity: 2 }, k2)));
  assert.equal(new Set(par.map((r) => r.json().transaction.id)).size, 1);
  assert.equal(par.filter((r) => r.statusCode === 201).length, 1);
  assert.equal((await item(cons.id)).quantityAvailable, 94);
  // a failed attempt does not poison its key
  const k3 = idem();
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 9999 }, k3)).statusCode, 409);
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 9999 }, k3)).statusCode, 409);
  await integrity();
});

test('consumable issue/return: partial returns, outstanding tracking, OVER_RETURN guard and supervisor override', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 20, name: 'Cable ties' });
  const out = await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 10 });
  assert.equal(out.json().transaction.stockDelta, -10);
  assert.equal(out.json().transaction.custodyDelta, 10);
  assert.equal((await item(cons.id)).quantityAvailable, 10);

  const part = await tx(staff.token, 'checkin', { itemId: cons.id, holderId: john.id, quantity: 8 });
  assert.equal(part.json().transaction.custodyDelta, -8);
  assert.equal((await item(cons.id)).quantityAvailable, 18);
  assert.equal((await tx(staff.token, 'checkin', { itemId: cons.id, quantity: 1 })).json().error.code, 'HOLDER_REQUIRED');

  const over = await tx(staff.token, 'checkin', { itemId: cons.id, holderId: john.id, quantity: 5 });
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().error.code, 'OVER_RETURN');
  assert.equal(over.json().error.details.outstanding, 2);
  assert.equal((await tx(staff.token, 'checkin', { itemId: cons.id, holderId: john.id, quantity: 5, overrideOverReturn: true })).statusCode, 403, 'staff cannot override');
  const ok = await tx(sup.token, 'checkin', { itemId: cons.id, holderId: john.id, quantity: 5, overrideOverReturn: true });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().transaction.custodyDelta, -2, 'custody clamps at zero, never negative');
  assert.equal(ok.json().transaction.stockDelta, 5);
  assert.equal(ok.json().transaction.overrideAuthorizedBy, sup.userId);
  assert.equal((await item(cons.id)).quantityAvailable, 23);
  await integrity();
});

test('asset check-in: holder must match; condition maps to the §12 state; retirement obeys policy', async () => {
  const other = await mkHolder(app, staff.token, 'Mary Eze');
  const a = await mkItem(app, admin.token, { type: 'asset' });
  await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id });
  const wrong = await tx(staff.token, 'checkin', { itemId: a.id, holderId: other.id });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().error.code, 'HOLDER_MISMATCH');
  assert.equal((await tx(staff.token, 'checkin', { itemId: a.id, holderId: john.id, condition: 'replaced' })).json().error.code, 'RETIREMENT_REQUIRES_APPROVAL');
  const dmg = await tx(staff.token, 'checkin', { itemId: a.id, condition: 'damaged', note: 'Chuck cracked' });
  assert.equal(dmg.json().transaction.holder.name, 'John Okafor', 'holder derived from custody when omitted');
  assert.equal((await item(a.id)).assetState, 'damaged');
  assert.equal((await item(a.id)).condition, 'damaged');
  assert.equal((await tx(staff.token, 'checkin', { itemId: a.id })).json().error.code, 'NOT_CHECKED_OUT');

  const b = await mkItem(app, admin.token, { type: 'asset' });
  await tx(staff.token, 'checkout', { itemId: b.id, holderId: john.id });
  await tx(staff.token, 'checkin', { itemId: b.id, condition: 'needs_inspection' });
  assert.equal((await item(b.id)).assetState, 'under_repair');
  const c = await mkItem(app, admin.token, { type: 'asset' });
  await tx(staff.token, 'checkout', { itemId: c.id, holderId: john.id });
  assert.equal((await tx(admin.token, 'checkin', { itemId: c.id, condition: 'replaced' })).statusCode, 201, 'admin may retire directly');
  assert.equal((await item(c.id)).assetState, 'retired');
  assert.equal((await tx(staff.token, 'checkout', { itemId: c.id, holderId: john.id })).json().error.code, 'ITEM_NOT_AVAILABLE');
  await integrity();
});

test('condition/state updates: every exit from a bad state is recorded; terminal and invalid transitions refused', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset' });
  await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id });
  assert.equal((await tx(staff.token, 'condition', { itemId: a.id, toState: 'under_repair', note: 'x' })).json().error.code, 'ITEM_CHECKED_OUT');
  await tx(staff.token, 'checkin', { itemId: a.id, condition: 'damaged', note: 'broken' });
  const repair = await tx(staff.token, 'condition', { itemId: a.id, toState: 'under_repair', note: 'Sent to workshop' });
  assert.equal(repair.statusCode, 201);
  assert.equal(repair.json().transaction.condition, 'needs_inspection');
  const back = await tx(staff.token, 'condition', { itemId: a.id, toState: 'available', note: 'Repaired and tested' });
  assert.deepEqual([back.json().transaction.stateBefore, back.json().transaction.stateAfter, back.json().transaction.condition], ['under_repair', 'available', 'good']);
  assert.equal((await tx(staff.token, 'condition', { itemId: a.id, note: 'x' })).json().error.code, 'NOTHING_TO_CHANGE');
  const retire = await tx(staff.token, 'condition', { itemId: a.id, toState: 'retired', note: 'End of life' });
  assert.equal(retire.statusCode, 202, 'retirement is approval-gated for staff (§32)');
  assert.equal((await item(a.id)).assetState, 'available', 'nothing changed yet');
  assert.equal((await tx(admin.token, 'condition', { itemId: a.id, toState: 'retired', note: 'End of life' })).statusCode, 201);
  assert.equal((await tx(admin.token, 'condition', { itemId: a.id, toState: 'available', note: 'x' })).json().error.code, 'INVALID_STATE', 'retired is terminal');
  const l = await mkItem(app, admin.token, { type: 'asset' });
  await tx(admin.token, 'loss', { itemId: l.id, note: 'Missing after site move' });
  assert.equal((await tx(admin.token, 'condition', { itemId: l.id, toState: 'under_repair', note: 'x' })).json().error.code, 'INVALID_TRANSITION');
  assert.equal((await tx(admin.token, 'condition', { itemId: l.id, toState: 'available', note: 'Found in van' })).statusCode, 201);
  await integrity();
});

test('consume & restock: consume creates no custody; restock adds; assets refused; types enforced', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10, minQuantity: 3 });
  const c = await tx(staff.token, 'consume', { itemId: cons.id, quantity: 4, holderId: john.id, purpose: 'Site wiring' });
  assert.equal(c.json().transaction.custodyDelta, 0);
  assert.equal(c.json().transaction.holder.name, 'John Okafor');
  const r = await tx(staff.token, 'restock', { itemId: cons.id, quantity: 20, reference: 'PO-1182' });
  assert.equal(r.json().transaction.stockDelta, 20);
  assert.equal((await item(cons.id)).quantityAvailable, 26);
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 27 })).json().error.code, 'INSUFFICIENT_STOCK');
  const asset = await mkItem(app, admin.token, { type: 'asset' });
  assert.equal((await tx(staff.token, 'consume', { itemId: asset.id, quantity: 1 })).json().error.code, 'NOT_APPLICABLE');
  assert.equal((await tx(staff.token, 'restock', { itemId: asset.id, quantity: 1 })).json().error.code, 'NOT_APPLICABLE');
  assert.equal((await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id })).json().error.code, 'QUANTITY_REQUIRED');
  assert.equal((await tx(staff.token, 'checkout', { itemId: asset.id, holderId: john.id, quantity: 3 })).json().error.code, 'NOT_APPLICABLE');
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 0 })).statusCode, 400);
  await integrity();
});

test('LOW-STOCK event fires exactly once per downward crossing of the minimum', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10, minQuantity: 5 });
  const n = async () => rows(await db.execute(sql`select count(*)::int n from domain_events where type = 'stock.low'`))[0].n;
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 4 }); // 6 — still above
  assert.equal(await n(), 0);
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 }); // 5 — at minimum → crosses
  assert.equal(await n(), 1);
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 }); // 4 — already below, no new event
  assert.equal(await n(), 1);
  await tx(staff.token, 'restock', { itemId: cons.id, quantity: 20 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 20 }); // back down through the minimum → new crossing
  assert.equal(await n(), 2);
});

test('loss & damage: first-class events for assets AND consumables; holder stays on the record; custody ends', async () => {
  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Drill 042' });
  await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id });
  const dmg = await tx(staff.token, 'damage', { itemId: drill.id, note: 'Dropped from scaffold' });
  assert.equal(dmg.statusCode, 201, 'damage is not approval-gated');
  const d = dmg.json().transaction;
  assert.deepEqual([d.type, d.stateBefore, d.stateAfter, d.custodyDelta, d.holder.name], ['damage', 'checked_out', 'damaged', -1, 'John Okafor']);
  assert.equal((await item(drill.id)).currentHolder, null);

  const gone = await mkItem(app, admin.token, { type: 'asset', name: 'Drill 043' });
  await tx(staff.token, 'checkout', { itemId: gone.id, holderId: john.id });
  const pending = await tx(staff.token, 'loss', { itemId: gone.id, note: 'Lost on site' });
  assert.equal(pending.statusCode, 202);
  assert.equal(pending.json().status, 'pending_approval');
  assert.equal((await item(gone.id)).assetState, 'checked_out', 'unchanged until approved');
  const approved = await callIdem(app, sup.token, 'POST', `/approvals/${pending.json().approval.id}/approve`, { note: 'Confirmed with site lead' });
  assert.equal(approved.statusCode, 200);
  const t = approved.json().transactions[0];
  assert.deepEqual([t.type, t.stateAfter, t.holder.name, t.actor.id, t.approvedBy], ['loss', 'lost', 'John Okafor', staff.userId, sup.userId]);
  assert.equal((await item(gone.id)).assetState, 'lost');
  const outstanding = (await call(app, admin.token, 'GET', `/transactions?holderId=${john.id}`)).json().items;
  assert.ok(outstanding.length > 0);

  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  assert.equal((await tx(sup.token, 'loss', { itemId: cons.id, quantity: 3, note: 'Spilled' })).json().transaction.stockDelta, -3);
  assert.equal((await tx(staff.token, 'damage', { itemId: cons.id, quantity: 2, note: 'Water damage' })).json().transaction.reason, 'damage');
  assert.equal((await tx(staff.token, 'loss', { itemId: cons.id, quantity: 1, note: '' })).statusCode, 400);
  assert.equal((await item(cons.id)).quantityAvailable, 5);
  await integrity();
});

test('adjustments: signed in the ledger (REGRESSION: +5 and −5 are distinguishable), reason rules, policy by role, large-threshold escalation', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 50 });
  assert.equal((await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -5, reason: 'count_correction' })).statusCode, 202, 'default: staff need approval');
  const s = await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: 5, reason: 'count_correction' });
  assert.equal(s.statusCode, 201);
  assert.equal(s.json().transaction.stockDelta, 5);
  const m = await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: -8, reason: 'unrecorded_movement' });
  assert.equal(m.json().transaction.stockDelta, -8);
  assert.equal(m.json().transaction.quantity, 8);
  assert.equal((await item(cons.id)).quantityAvailable, 47);
  assert.equal((await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: 1, reason: 'other' })).json().error.code, 'NOTE_REQUIRED');
  assert.equal((await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: 0, reason: 'other', note: 'x' })).statusCode, 422);
  assert.equal((await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: -48, reason: 'count_correction' })).json().error.code, 'INSUFFICIENT_STOCK');

  await setPolicy({ largeAdjustmentThreshold: 20 });
  assert.equal((await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: -10, reason: 'count_correction' })).statusCode, 201, 'below threshold: supervisor direct');
  assert.equal((await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: -25, reason: 'count_correction' })).statusCode, 202, 'at/above threshold: supervisor needs approval');
  assert.equal((await tx(admin.token, 'adjust', { itemId: cons.id, quantityDelta: -25, reason: 'count_correction' })).statusCode, 201, 'admin is the final authority');
  await setPolicy({ adjustmentMode: 'direct' });
  assert.equal((await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: 1, reason: 'count_correction' })).statusCode, 201, 'direct mode: nobody waits');
  await integrity();
});

test('approvals: visibility, no self-approval, reject needs a note, double-decision refused, live re-validation, concurrent decisions → one winner', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const p1 = (await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -6, reason: 'count_correction' })).json().approval;
  const other = await createUser(app, admin, 'store_staff');
  assert.equal((await call(app, other.token, 'GET', `/approvals/${p1.id}`)).statusCode, 404, 'staff see only their own');
  assert.equal((await call(app, staff.token, 'GET', `/approvals/${p1.id}`)).statusCode, 200);
  assert.equal((await call(app, other.token, 'GET', '/approvals')).json().items.length, 0);
  assert.equal((await call(app, sup.token, 'GET', '/approvals')).json().items.length, 1);
  assert.equal((await callIdem(app, staff.token, 'POST', `/approvals/${p1.id}/approve`, {})).statusCode, 403);
  assert.equal((await callIdem(app, sup.token, 'POST', `/approvals/${p1.id}/reject`, {})).statusCode, 400, 'a rejection must say why');

  // live re-validation: the stock the request relied on is gone by approval time → refused, stays pending
  await tx(sup.token, 'consume', { itemId: cons.id, quantity: 8 });
  const blocked = await callIdem(app, sup.token, 'POST', `/approvals/${p1.id}/approve`, {});
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await call(app, sup.token, 'GET', `/approvals/${p1.id}`)).json().status, 'pending');
  await tx(sup.token, 'restock', { itemId: cons.id, quantity: 10 });

  // concurrent approve vs reject vs cancel: exactly one decision lands
  const res = await Promise.all([
    callIdem(app, sup.token, 'POST', `/approvals/${p1.id}/approve`, {}),
    callIdem(app, admin.token, 'POST', `/approvals/${p1.id}/reject`, { note: 'no' }),
    call(app, staff.token, 'POST', `/approvals/${p1.id}/cancel`),
  ]);
  assert.equal(res.filter((r) => r.statusCode === 200).length, 1);
  assert.ok(res.filter((r) => r.statusCode !== 200).every((r) => r.json().error.code === 'APPROVAL_NOT_PENDING'));
  const final = (await call(app, sup.token, 'GET', `/approvals/${p1.id}`)).json();
  assert.notEqual(final.status, 'pending');
  assert.equal(rows(await db.execute(sql`select count(*)::int n from transactions where approval_id = ${p1.id}`))[0].n, final.status === 'approved' ? 1 : 0, 'an approval executes at most once');

  // self-approval is blocked: a supervisor under all_approval cannot approve their own request
  await setPolicy({ adjustmentMode: 'all_approval' });
  const mine = (await tx(sup.token, 'adjust', { itemId: cons.id, quantityDelta: 1, reason: 'count_correction' })).json().approval;
  assert.equal((await callIdem(app, sup.token, 'POST', `/approvals/${mine.id}/approve`, {})).json().error.code, 'CANNOT_APPROVE_OWN');
  assert.equal((await callIdem(app, admin.token, 'POST', `/approvals/${mine.id}/approve`, {})).statusCode, 200);
  await integrity();
});

test('approval requests are idempotent: the same key returns the same pending request, never a second one', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const key = idem();
  const a = await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -1, reason: 'count_correction' }, key);
  const b = await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -1, reason: 'count_correction' }, key);
  assert.equal(a.statusCode, 202);
  assert.equal(b.statusCode, 202);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(a.json().approval.id, b.json().approval.id);
  assert.equal((await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -2, reason: 'count_correction' }, key)).json().error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(rows(await db.execute(sql`select count(*)::int n from pending_approvals`))[0].n, 1);
});

test('optional approval for routine ops (§32): when enabled, a checkout is deferred, then executes on approval', async () => {
  await setPolicy({ checkoutMode: 'staff_approval' });
  const drill = await mkItem(app, admin.token, { type: 'asset' });
  const r = await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id });
  assert.equal(r.statusCode, 202);
  assert.equal((await item(drill.id)).assetState, 'available');
  assert.equal((await tx(sup.token, 'checkout', { itemId: drill.id, holderId: john.id })).statusCode, 201, 'supervisors are not queued in staff_approval mode');
  await tx(sup.token, 'checkin', { itemId: drill.id });
  const ok = await callIdem(app, sup.token, 'POST', `/approvals/${r.json().approval.id}/approve`, {});
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().transactions[0].actor.id, staff.userId);
  assert.equal((await item(drill.id)).assetState, 'checked_out');
  await integrity();
});

test('OVERRIDE (§13.3 vs §38): supervisors may check out beyond recorded stock — stock never goes negative; the gap is an explicit ledger adjustment', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 3 });
  assert.equal((await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 5, override: true })).statusCode, 403);
  assert.equal((await tx(sup.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 5 })).json().error.code, 'INSUFFICIENT_STOCK');
  const r = await tx(sup.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 5, override: true });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().transactions.length, 2);
  const [adj, out] = r.json().transactions;
  assert.deepEqual([adj.type, adj.reason, adj.stockDelta, adj.overrideAuthorizedBy], ['adjustment', 'unrecorded_movement', 2, sup.userId]);
  assert.deepEqual([out.type, out.stockDelta, out.balanceBefore, out.balanceAfter, out.overrideAuthorizedBy], ['checkout', -5, 5, 0, sup.userId]);
  assert.equal((await item(cons.id)).quantityAvailable, 0);
  const replay = await tx(sup.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 5, override: true }, r.json().transaction.idempotencyKey);
  void replay;
  await integrity();
});

test('batch checkout: atomic, request-ordered, line errors identify the line, duplicates refused, replay-safe, deadlock-free', async () => {
  const [a, b, c] = await Promise.all([mkItem(app, admin.token, { type: 'asset' }), mkItem(app, admin.token, { type: 'asset' }), mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 })]);
  const key = idem();
  const body = { holderId: john.id, purpose: 'Day shift kit', lines: [{ itemId: c.id, quantity: 4 }, { itemId: a.id }, { itemId: b.id }] };
  const ok = await tx(staff.token, 'checkout/batch', body, key);
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().transactions.map((t: any) => t.itemId), [c.id, a.id, b.id], 'returned in request order');
  const replay = await tx(staff.token, 'checkout/batch', body, key);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().transactions.length, 3);
  assert.equal((await item(c.id)).quantityAvailable, 6);

  const d = await mkItem(app, admin.token, { type: 'asset' });
  const bad = await tx(staff.token, 'checkout/batch', { holderId: john.id, lines: [{ itemId: d.id }, { itemId: a.id }] }); // a is already out
  assert.equal(bad.statusCode, 409);
  assert.equal(bad.json().error.details.lineIndex, 1);
  assert.equal((await item(d.id)).assetState, 'available', 'all-or-nothing: line 0 rolled back');
  assert.equal((await tx(staff.token, 'checkout/batch', { holderId: john.id, lines: [{ itemId: d.id }, { itemId: d.id }] })).json().error.code, 'DUPLICATE_LINE');
  assert.equal((await tx(staff.token, 'checkout/batch', { holderId: john.id, lines: [] })).statusCode, 400);

  // opposite-ordered overlapping batches would deadlock without a canonical lock order
  const x = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 1000 });
  const y = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 1000 });
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => tx(staff.token, 'checkout/batch', { holderId: john.id, lines: i % 2 ? [{ itemId: x.id, quantity: 1 }, { itemId: y.id, quantity: 1 }] : [{ itemId: y.id, quantity: 1 }, { itemId: x.id, quantity: 1 }] })));
  assert.ok(res.every((r) => r.statusCode === 201), res.map((r) => r.statusCode).join());
  assert.equal((await item(x.id)).quantityAvailable, 980);
  await integrity();
});

test('CORRECTIONS: reversal + replacement rows, linked, history untouched; wrong holder / wrong quantity / wrong item', async () => {
  const mary = await mkHolder(app, staff.token, 'Mary Eze');
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 20 });
  const wrong = (await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 10 })).json().transaction;
  assert.equal((await tx(staff.token, 'checkin', { itemId: cons.id, holderId: john.id, quantity: 4 })).statusCode, 201);

  assert.equal((await tx(staff.token, `${wrong.id}/correct`, { note: 'x' })).statusCode, 403, 'admin only');
  // John has 6 outstanding; reversing the whole 10 would push his custody below zero → blocked
  const blocked = await tx(admin.token, `${wrong.id}/correct`, { note: 'Wrong holder' });
  assert.equal(blocked.json().error.code, 'CORRECTION_BLOCKED');
  assert.equal((await item(cons.id)).quantityAvailable, 14);

  const fresh = (await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 4 })).json().transaction; // stock 14 → 10
  const fix = await tx(admin.token, `${fresh.id}/correct`, { note: 'Should have been Mary, and 3 not 4', replacement: { holderId: mary.id, quantity: 3 } });
  assert.equal(fix.statusCode, 201);
  const [rev, rep] = fix.json().transactions;
  assert.deepEqual([rev.type, rev.stockDelta, rev.custodyDelta, rev.correctsTransactionId, rev.holder.name], ['correction', 4, -4, fresh.id, 'John Okafor']);
  assert.deepEqual([rep.type, rep.stockDelta, rep.custodyDelta, rep.correctsTransactionId, rep.relatedTransactionId, rep.holder.name], ['checkout', -3, 3, fresh.id, rev.id, 'Mary Eze']);
  assert.equal((await item(cons.id)).quantityAvailable, 11);
  const original = (await call(app, admin.token, 'GET', `/transactions/${fresh.id}`)).json();
  assert.equal(original.quantity, 4, 'the original row is untouched');
  assert.equal((await tx(admin.token, `${fresh.id}/correct`, { note: 'again' })).json().error.code, 'ALREADY_CORRECTED');
  assert.equal((await tx(admin.token, `${rev.id}/correct`, { note: 'x' })).json().error.code, 'NOT_CORRECTABLE');
  await integrity();

  const ghost = await tx(admin.token, `${crypto.randomUUID()}/correct`, { note: 'x' });
  assert.equal(ghost.statusCode, 404);
});

test('corrections: restock that was since consumed is blocked; wrong-item replacement; invalid replacement fields refused; concurrent double-correct → one winner', async () => {
  const a = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 0 });
  const b = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 0 });
  const rs = (await tx(staff.token, 'restock', { itemId: a.id, quantity: 10 })).json().transaction;
  await tx(staff.token, 'consume', { itemId: a.id, quantity: 8 });
  const blocked = await tx(admin.token, `${rs.id}/correct`, { note: 'Added to the wrong item' });
  assert.equal(blocked.json().error.code, 'CORRECTION_BLOCKED');

  const rs2 = (await tx(staff.token, 'restock', { itemId: b.id, quantity: 5 })).json().transaction;
  assert.equal((await tx(admin.token, `${rs2.id}/correct`, { note: 'x', replacement: { holderId: john.id } })).json().error.code, 'INVALID_REPLACEMENT');
  const moved = await tx(admin.token, `${rs2.id}/correct`, { note: 'Belonged to item A', replacement: { itemId: a.id } });
  assert.equal(moved.statusCode, 201);
  assert.equal((await item(b.id)).quantityAvailable, 0);
  assert.equal((await item(a.id)).quantityAvailable, 7);

  const rs3 = (await tx(staff.token, 'restock', { itemId: b.id, quantity: 5 })).json().transaction;
  const race = await Promise.all([tx(admin.token, `${rs3.id}/correct`, { note: 'one' }), tx(admin.token, `${rs3.id}/correct`, { note: 'two' })]);
  assert.equal(race.filter((r) => r.statusCode === 201).length, 1);
  assert.equal((await item(b.id)).quantityAvailable, 0);
  await integrity();
});

test('corrections for assets: undo a wrong checkout; blocked once later activity depends on it; loss/damage reversals restore custody', async () => {
  const mary = await mkHolder(app, staff.token, 'Mary Eze');
  const a = await mkItem(app, admin.token, { type: 'asset' });
  const co = (await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id })).json().transaction;
  const fix = await tx(admin.token, `${co.id}/correct`, { note: 'Wrong person', replacement: { holderId: mary.id } });
  assert.equal(fix.statusCode, 201);
  assert.equal((await item(a.id)).currentHolder.name, 'Mary Eze');
  const ci = (await tx(staff.token, 'checkin', { itemId: a.id })).json().transaction;
  assert.equal((await tx(admin.token, `${fix.json().transactions[1].id}/correct`, { note: 'x' })).json().error.code, 'CORRECTION_BLOCKED', 'it has since been returned');
  const undoReturn = await tx(admin.token, `${ci.id}/correct`, { note: 'Not actually returned yet' });
  assert.equal(undoReturn.statusCode, 201);
  const back = await item(a.id);
  assert.deepEqual([back.assetState, back.currentHolder.name], ['checked_out', 'Mary Eze']);
  assert.ok(back.dueAt === null || typeof back.dueAt === 'string');

  const dm = (await tx(staff.token, 'damage', { itemId: a.id, note: 'cracked' })).json().transaction;
  assert.equal((await item(a.id)).assetState, 'damaged');
  assert.equal((await tx(admin.token, `${dm.id}/correct`, { note: 'It was fine' })).statusCode, 201);
  assert.equal((await item(a.id)).assetState, 'checked_out');
  assert.equal((await item(a.id)).currentHolder.name, 'Mary Eze');
  await integrity();
});

test('photo policy: when required, a snapshot is mandatory; it must be a transaction snapshot from this org', async () => {
  await call(app, admin.token, 'PATCH', '/organization/settings', { requirePhotoFor: ['checkout', 'damage'] });
  const a = await mkItem(app, admin.token, { type: 'asset' });
  assert.equal((await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id })).json().error.code, 'PHOTO_REQUIRED');
  const snap = (await upload(app, staff.token, 'transaction_snapshot')).json().id;
  const wrongKind = (await upload(app, staff.token, 'item_photo')).json().id;
  assert.equal((await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id, snapshotFileId: wrongKind })).json().error.code, 'FILE_NOT_FOUND');
  const other = await registerOrg(app, 'Other');
  const foreign = (await upload(app, other.token, 'transaction_snapshot')).json().id;
  assert.equal((await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id, snapshotFileId: foreign })).json().error.code, 'FILE_NOT_FOUND');
  const ok = await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id, snapshotFileId: snap });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().transaction.snapshotFileId, snap);
  assert.equal((await tx(staff.token, 'checkin', { itemId: a.id })).statusCode, 201, 'check-in not in the required list');
});

test('archived items cannot transact; archive is blocked while an asset is out or a consumable is outstanding', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset' });
  await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id });
  assert.equal((await call(app, admin.token, 'POST', `/items/${a.id}/archive`)).json().error.code, 'ITEM_IN_USE');
  await tx(staff.token, 'checkin', { itemId: a.id });
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 2 });
  assert.equal((await call(app, admin.token, 'POST', `/items/${cons.id}/archive`)).json().error.code, 'ITEM_HAS_OUTSTANDING');
  await tx(staff.token, 'checkin', { itemId: cons.id, holderId: john.id, quantity: 2 });
  assert.equal((await call(app, admin.token, 'POST', `/items/${cons.id}/archive`)).statusCode, 200);
  for (const [op, body] of [['checkout', { itemId: cons.id, holderId: john.id, quantity: 1 }], ['consume', { itemId: cons.id, quantity: 1 }], ['restock', { itemId: cons.id, quantity: 1 }], ['adjust', { itemId: cons.id, quantityDelta: 1, reason: 'count_correction' }]] as const) {
    assert.equal((await tx(admin.token, op, body)).json().error.code, 'ITEM_ARCHIVED', op);
  }
  await integrity();
});

test('holders: deactivated/archived holders cannot receive items; a holder with items out cannot be archived; workers need no account', async () => {
  const a = await mkItem(app, admin.token, { type: 'asset' });
  await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id });
  assert.equal((await call(app, admin.token, 'POST', `/holders/${john.id}/archive`)).json().error.code, 'HOLDER_HAS_OUTSTANDING');
  await tx(staff.token, 'checkin', { itemId: a.id });
  await call(app, admin.token, 'POST', `/holders/${john.id}/archive`);
  assert.equal((await tx(staff.token, 'checkout', { itemId: a.id, holderId: john.id })).json().error.code, 'HOLDER_INACTIVE');
  await call(app, admin.token, 'PATCH', `/users/${staff.userId}`, { active: false });
  const stellaHolder = (await call(app, admin.token, 'GET', '/holders?kind=person&q=Stella')).json().items[0];
  assert.equal((await tx(sup.token, 'checkout', { itemId: a.id, holderId: stellaHolder.id })).json().error.code, 'HOLDER_INACTIVE', 'a deactivated user cannot be issued items');
  assert.equal((await tx(sup.token, 'checkout', { itemId: a.id, holderId: crypto.randomUUID() })).json().error.code, 'HOLDER_NOT_FOUND');
});

test('permissions: viewers and anonymous callers cannot write; unknown body fields are refused (no smuggling stockDelta)', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  for (const op of ['checkout', 'checkin', 'consume', 'restock', 'adjust', 'loss', 'damage', 'condition']) {
    assert.equal((await tx(viewer.token, op, { itemId: cons.id })).statusCode, 403, op);
    assert.equal((await call(app, null, 'POST', `/transactions/${op}`, { itemId: cons.id }, { 'idempotency-key': idem() })).statusCode, 401, op);
  }
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1, stockDelta: 100 })).statusCode, 400);
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1, actorUserId: admin.userId })).statusCode, 400);
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1, occurredAt: '2020-01-01T00:00:00Z' })).statusCode, 400, 'online callers cannot back-date the ledger');
  assert.equal((await call(app, viewer.token, 'GET', '/transactions')).statusCode, 200);
});

test('TENANT ISOLATION across the engine: other orgs cannot touch items, holders, transactions or approvals', async () => {
  const other = await registerOrg(app, 'Rival Co');
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const co = (await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 2 })).json().transaction;
  const pending = (await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -1, reason: 'count_correction' })).json().approval;
  const theirs = await mkHolder(app, other.token, 'Their Worker');
  const theirItem = await mkItem(app, other.token, { type: 'consumable', openingQuantity: 5 });

  assert.equal((await tx(other.token, 'consume', { itemId: cons.id, quantity: 1 })).statusCode, 404);
  assert.equal((await tx(other.token, 'consume', { itemId: theirItem.id, quantity: 1, holderId: john.id })).json().error.code, 'HOLDER_NOT_FOUND');
  assert.equal((await tx(other.token, 'checkout', { itemId: theirItem.id, holderId: john.id, quantity: 1 })).json().error.code, 'HOLDER_NOT_FOUND');
  assert.equal((await tx(admin.token, 'checkout', { itemId: cons.id, holderId: theirs.id, quantity: 1 })).json().error.code, 'HOLDER_NOT_FOUND');
  assert.equal((await tx(other.token, `${co.id}/correct`, { note: 'x' })).statusCode, 404);
  assert.equal((await call(app, other.token, 'GET', `/transactions/${co.id}`)).statusCode, 404);
  assert.equal((await call(app, other.token, 'GET', `/approvals/${pending.id}`)).statusCode, 404);
  assert.equal((await callIdem(app, other.token, 'POST', `/approvals/${pending.id}/approve`, {})).statusCode, 404);
  assert.equal((await call(app, other.token, 'GET', '/transactions')).json().items.some((t: any) => t.itemId === cons.id), false);
  assert.equal((await item(cons.id)).quantityAvailable, 8);
  // the same Idempotency-Key in two orgs is two different requests
  const key = idem();
  assert.equal((await tx(admin.token, 'consume', { itemId: cons.id, quantity: 1 }, key)).statusCode, 201);
  assert.equal((await tx(other.token, 'consume', { itemId: theirItem.id, quantity: 1 }, key)).statusCode, 201);
  await integrity();
});

test('every ledger row has an audit event naming its transaction; the audit log is complete for the scenario', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 });
  await tx(staff.token, 'restock', { itemId: cons.id, quantity: 5 });
  const missing = rows(await db.execute(sql`select t.id from transactions t where not exists (select 1 from audit_events a where a.transaction_id = t.id)`));
  assert.equal(missing.length, 0);
  const a = rows(await db.execute(sql`select previous, next, actor_user_id from audit_events where action = 'transaction.consume'`))[0];
  assert.deepEqual([a.previous, a.next, a.actor_user_id], [{ quantity: 10 }, { quantity: 9 }, staff.userId]);
});

test('metrics: transaction outcomes are exported (committed / replayed / conflict / deferred)', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 1 });
  const key = idem();
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 }, key);
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 }, key);
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 });
  await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: 1, reason: 'count_correction' });
  const body = (await app.inject('/metrics')).body;
  for (const o of ['committed', 'replayed', 'conflict', 'deferred']) assert.match(body, new RegExp(`storekeeper_transactions_total\\{type="[a-z_]+",outcome="${o}"\\}`), o);
  void eq; void items;
});

test('REGRESSION: JSON null is never coerced to 0/false (it once turned an unset approval threshold into 0)', async () => {
  const put = await setPolicy({ adjustmentMode: 'direct', largeAdjustmentThreshold: null });
  assert.equal(put.json().largeAdjustmentThreshold, null);
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 50, minQuantity: 10 });
  assert.equal((await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: 1, reason: 'count_correction' })).statusCode, 201, 'direct mode with no threshold: nobody waits');
  const cleared = await call(app, admin.token, 'PATCH', `/items/${cons.id}`, { minQuantity: null });
  assert.equal(cleared.json().minQuantity, null, 'null clears a threshold; it does not set it to 0');
  const cat = await mkCategory(app, admin.token, { name: 'NullCat', defaultMinQuantity: 5 });
  assert.equal((await call(app, admin.token, 'PATCH', `/categories/${cat.id}`, { defaultMinQuantity: null })).json().defaultMinQuantity, null);
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1, holderId: null })).statusCode, 400, 'null for a non-nullable field is rejected, not coerced');
  assert.equal((await tx(staff.token, 'checkout', { itemId: cons.id, holderId: john.id, quantity: 1, override: null })).statusCode, 400);
  assert.equal((await tx(staff.token, 'consume', { itemId: cons.id, quantity: '1' })).statusCode, 400, 'a string is not a number in a JSON body');
  assert.equal((await call(app, admin.token, 'GET', '/items?limit=2&lowStock=false')).statusCode, 200, 'query strings are still coerced');
}); 
