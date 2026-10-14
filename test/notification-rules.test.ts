/** Role-based notification routing: defaults, override, validation, effect on the NEXT event, audit. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { sentMessages } from '../src/modules/mail/mailer.js';
import { dispatchDueEmails } from '../src/modules/mail/outbox.js';
import { processDomainEvents, ROUTABLE_TYPES } from '../src/modules/notifications/service.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, mkItem, auditRows, idem, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session, viewer: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app); admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff'); viewer = await createUser(app, admin, 'viewer'); sentMessages.length = 0;
});

const pump = async () => { await processDomainEvents(db); await dispatchDueEmails(db); };
const lowStock = async (n = 1) => {
  const it = await mkItem(app, admin.token, { type: 'consumable', name: `Rods ${n}`, openingQuantity: 10, minQuantity: 5, unit: 'box' });
  await callIdem(app, admin.token, 'POST', '/transactions/consume', { itemId: it.id, quantity: 9 }, idem()); return it;
};
const lows = async (s: Session) => ((await call(app, s.token, 'GET', '/notifications?limit=100')).json().items as any[]).filter((n) => n.type === 'low_stock');
const rules = async (s = admin) => (await call(app, s.token, 'GET', '/organization/notification-rules')).json().items as Array<{ type: string; roles: string[]; isDefault: boolean }>;
const put = (type: string, roles: unknown, s = admin) => call(app, s.token, 'PUT', `/organization/notification-rules/${type}`, { roles });

test('defaults: every routable type lists admin + supervisor and is flagged isDefault; every role may read, none besides admin may write', async () => {
  for (const s of [admin, sup, staff, viewer]) {
    const r = await rules(s);
    assert.deepEqual(r.map((x) => x.type).sort(), [...ROUTABLE_TYPES].sort());
    assert.ok(r.every((x) => x.isDefault && x.roles.join() === 'admin,supervisor'));
  }
  for (const s of [sup, staff, viewer]) assert.equal((await put('low_stock', ['viewer'], s)).statusCode, 403);
});

test('default routing: admin + supervisor are notified, staff and viewer are not', async () => {
  await lowStock(); await pump();
  assert.equal((await lows(admin)).length, 1); assert.equal((await lows(sup)).length, 1);
  assert.equal((await lows(staff)).length, 0); assert.equal((await lows(viewer)).length, 0);
});

test('override: routing to store_staff only redirects the NEXT event; the type flips to isDefault=false; other types stay default', async () => {
  assert.equal((await put('low_stock', ['store_staff'])).statusCode, 204);
  const r = await rules(); const ls = r.find((x) => x.type === 'low_stock')!;
  assert.deepEqual([ls.roles, ls.isDefault], [['store_staff'], false]);
  assert.ok(r.filter((x) => x.type !== 'low_stock').every((x) => x.isDefault));
  await lowStock(); await pump();
  assert.equal((await lows(staff)).length, 1);
  for (const s of [admin, sup, viewer]) assert.equal((await lows(s)).length, 0, s.email);
});

test('a rule change affects events not yet fanned out, never notifications already delivered', async () => {
  await lowStock(1); await pump();
  assert.equal((await lows(admin)).length, 1);
  await put('low_stock', ['viewer']);
  await lowStock(2); await pump();
  assert.equal((await lows(admin)).length, 1, 'admin keeps the old one, gets no new one');
  assert.equal((await lows(viewer)).length, 1);
});

test('role changes take effect on the next event: promoting a viewer to supervisor adds them to a supervisor-routed alert', async () => {
  await put('low_stock', ['supervisor']);
  await lowStock(1); await pump(); assert.equal((await lows(viewer)).length, 0);
  assert.equal((await call(app, admin.token, 'PATCH', `/users/${viewer.userId}`, { role: 'supervisor' })).statusCode, 200);
  await lowStock(2); await pump();
  assert.equal((await lows(viewer)).length, 1); assert.equal((await lows(sup)).length, 2);
});

test('deactivated users never receive routed alerts', async () => {
  await call(app, admin.token, 'PATCH', `/users/${sup.userId}`, { active: false });
  await lowStock(); await pump();
  const n = await db.execute(sql`select count(*)::int as n from notifications where user_id = ${sup.userId}`);
  assert.equal((Array.isArray(n) ? n : (n as any).rows)[0].n, 0); assert.equal((await lows(admin)).length, 1);
});

test('routing and e-mail compose: a routed role gets mail when the org enables e-mail for that type', async () => {
  await put('low_stock', ['viewer']); await call(app, admin.token, 'PATCH', '/organization/settings', { notificationEmailTypes: ['low_stock'] });
  await lowStock(); await pump();
  assert.deepEqual(sentMessages.filter((m) => /Low stock/.test(m.subject)).map((m) => m.to), [viewer.email]);
});

test('NOT_CONFIGURABLE: approval_decided and announcement are not routed by role; unknown types likewise (422)', async () => {
  for (const t of ['approval_decided', 'announcement', 'made_up']) {
    const r = await put(t, ['admin']); assert.equal(r.statusCode, 422, t); assert.equal(r.json().error.code, 'NOT_CONFIGURABLE');
  }
  assert.ok((await rules()).every((x) => x.isDefault), 'nothing was stored');
});

test('validation: empty roles, unknown role, too many roles and extra fields are rejected; duplicates collapse', async () => {
  assert.equal((await put('low_stock', [])).statusCode, 400); assert.equal((await put('low_stock', ['owner'])).statusCode, 400);
  assert.equal((await put('low_stock', ['admin', 'admin', 'viewer', 'viewer', 'staff'])).statusCode, 400);
  assert.equal((await call(app, admin.token, 'PUT', '/organization/notification-rules/low_stock', { roles: ['admin'], extra: 1 })).statusCode, 400);
  assert.equal((await put('low_stock', ['admin', 'admin', 'viewer'])).statusCode, 204);
  assert.deepEqual((await rules()).find((x) => x.type === 'low_stock')!.roles, ['admin', 'viewer']);
});

test('audit: each change records previous (default when unset) and next roles, attributed to the admin', async () => {
  await put('overdue_checkout', ['store_staff']); await put('overdue_checkout', ['viewer', 'supervisor']);
  const rows = (await auditRows(admin.orgId, 'notification.rules_changed')).slice(-2);
  assert.deepEqual(rows[0].previous, { type: 'overdue_checkout', roles: ['admin', 'supervisor'] }); assert.deepEqual(rows[0].next, { type: 'overdue_checkout', roles: ['store_staff'] });
  assert.deepEqual(rows[1].previous, { type: 'overdue_checkout', roles: ['store_staff'] }); assert.deepEqual(rows[1].next, { type: 'overdue_checkout', roles: ['viewer', 'supervisor'] });
  assert.ok(rows.every((r) => r.actorUserId === admin.userId && r.entityId === admin.orgId));
});

test('tenancy: one organization’s routing never affects another’s', async () => {
  const rival = await registerOrg(app, 'Rival'); await put('low_stock', ['viewer']);
  assert.ok((await rules(rival)).every((x) => x.isDefault));
  const it = await mkItem(app, rival.token, { type: 'consumable', name: 'Rival rods', openingQuantity: 10, minQuantity: 5, unit: 'box' });
  await callIdem(app, rival.token, 'POST', '/transactions/consume', { itemId: it.id, quantity: 9 }, idem()); await pump();
  assert.equal((await lows(rival)).length, 1, 'rival admin still gets the default routing');
});
