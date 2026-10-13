/** Announcements: role audience (jsonb `?` through Drizzle), delivery, e-mail + opt-out, expiry, retract, stats, idempotency, audit. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { sentMessages } from '../src/modules/mail/mailer.js';
import { dispatchDueEmails } from '../src/modules/mail/outbox.js';
import { processDomainEvents } from '../src/modules/notifications/service.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, auditRows, idem, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session, staff2: Session, viewer: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app); admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff');
  staff2 = await createUser(app, admin, 'store_staff'); viewer = await createUser(app, admin, 'viewer'); sentMessages.length = 0;
});

const pump = async () => { const e = await processDomainEvents(db); await dispatchDueEmails(db); return e; };
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const publish = (body: Record<string, unknown>, token = admin.token) => callIdem(app, token, 'POST', '/announcements', { title: 'Yard closed', body: 'The yard is closed on Friday.', ...body });
const inbox = async (s: Session) => ((await call(app, s.token, 'GET', '/notifications?limit=100')).json().items as any[]).filter((n) => n.type === 'announcement');
const visible = async (s: Session, q = '') => (await call(app, s.token, 'GET', `/announcements${q}`)).json().items as any[];
const everyone = [() => admin, () => sup, () => staff, () => staff2, () => viewer];

test('audience: a single role reaches only that role', async () => {
  assert.equal((await publish({ audienceRoles: ['supervisor'] })).statusCode, 201); await pump();
  assert.equal((await inbox(sup)).length, 1);
  for (const s of [admin, staff, staff2, viewer]) assert.equal((await inbox(s)).length, 0, s.email);
});

test('audience: several roles; each recipient gets exactly one copy with the title and body', async () => {
  await publish({ audienceRoles: ['store_staff', 'viewer'], title: 'Stocktake Monday', body: 'Bring your scanners.' }); await pump();
  for (const s of [staff, staff2, viewer]) { const n = await inbox(s); assert.equal(n.length, 1); assert.equal(n[0].title, 'Stocktake Monday'); assert.equal(n[0].body, 'Bring your scanners.'); }
  for (const s of [admin, sup]) assert.equal((await inbox(s)).length, 0);
});

test('audience: empty (or omitted) means everyone, including the publisher; duplicates in the audience collapse', async () => {
  await publish({}); await publish({ audienceRoles: [], title: 'Second' }); await pump();
  for (const s of everyone.map((f) => f())) assert.equal((await inbox(s)).length, 2, s.email);
  const r = await publish({ audienceRoles: ['viewer', 'viewer'], title: 'Dup' });
  assert.deepEqual(r.json().audienceRoles, ['viewer']);
});

test('people who have not accepted their invitation yet, and deactivated users, receive nothing', async () => {
  const pending = (await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'pending@acme.test', role: 'store_staff' })).json();
  await call(app, admin.token, 'PATCH', `/users/${staff2.userId}`, { active: false });
  await publish({}); await pump();
  const n = rows(await db.execute(sql`select user_id from notifications where type = 'announcement'`)).map((r) => r.user_id);
  assert.ok(!n.includes(pending.id)); assert.ok(!n.includes(staff2.userId)); assert.equal(n.length, 4, 'admin, supervisor, staff, viewer');
  assert.equal(new Set(n).size, n.length);
});

test('delivery is idempotent: processing again — even after the event is re-opened — creates no duplicates', async () => {
  await publish({}); const first = await pump(); assert.equal(first.processed, 1);
  assert.equal((await pump()).processed, 0);
  await db.execute(sql`update domain_events set processed_at = null where type = 'announcement.published'`);
  assert.equal((await pump()).processed, 1);
  for (const s of everyone.map((f) => f())) assert.equal((await inbox(s)).length, 1, s.email);
});

test('publishing is idempotent on the Idempotency-Key: a replay returns the same announcement and creates one', async () => {
  const key = idem();
  const body = { title: 'Replay me', body: 'x' };
  const r1 = await callIdem(app, admin.token, 'POST', '/announcements', body, key); const r2 = await callIdem(app, admin.token, 'POST', '/announcements', body, key);
  assert.equal(r1.statusCode, 201); assert.equal(r2.json().id, r1.json().id);
  assert.equal((await visible(admin, '?all=true')).filter((x) => x.title === 'Replay me').length, 1);
});

test('e-mail: off by default; sendEmail forces it to the audience; escaped HTML; per-user opt-out is respected', async () => {
  await publish({ audienceRoles: ['store_staff'], title: 'No mail' }); await pump();
  assert.equal(sentMessages.filter((m) => m.subject === 'No mail').length, 0);

  await call(app, staff2.token, 'PUT', '/notifications/preferences/announcement', { email: false });
  await publish({ audienceRoles: ['store_staff', 'viewer'], title: 'Mail me', body: 'Use <b>gloves</b> & goggles', sendEmail: true }); await pump();
  const mails = sentMessages.filter((m) => m.subject === 'Mail me');
  assert.deepEqual(mails.map((m) => m.to).sort(), [staff.email, viewer.email].sort(), 'staff2 opted out of e-mail');
  assert.ok(mails.every((m) => !m.html!.includes('<b>gloves</b>') && m.html!.includes('&lt;b&gt;gloves&lt;/b&gt;')));
  assert.equal((await inbox(staff2)).filter((n) => n.title === 'Mail me').length, 1, 'opting out of e-mail keeps the in-app copy');
});

test('a user who opted IN to announcement e-mail gets it even when the announcement did not request e-mail; in-app opt-out suppresses the bell only', async () => {
  await call(app, viewer.token, 'PUT', '/notifications/preferences/announcement', { email: true });
  await call(app, sup.token, 'PUT', '/notifications/preferences/announcement', { inApp: false });
  await publish({ title: 'Quiet one' }); await pump();
  assert.deepEqual(sentMessages.filter((m) => m.subject === 'Quiet one').map((m) => m.to), [viewer.email]);
  assert.equal((await inbox(sup)).length, 0); assert.equal((await inbox(viewer)).length, 1);
});

test('visibility: GET /announcements is scoped to the caller’s role and to active announcements', async () => {
  await publish({ audienceRoles: ['supervisor'], title: 'Sup only' }); await publish({ audienceRoles: ['viewer'], title: 'Viewer only' }); await publish({ title: 'All hands' });
  const t = async (s: Session) => (await visible(s)).map((a) => a.title).sort();
  assert.deepEqual(await t(sup), ['All hands', 'Sup only']);
  assert.deepEqual(await t(viewer), ['All hands', 'Viewer only']);
  assert.deepEqual(await t(staff), ['All hands']);
  assert.deepEqual(await t(admin), ['All hands'], 'the default list is the banner list: admins see what is addressed to admins');
  assert.deepEqual((await visible(admin, '?all=true')).map((a) => a.title).sort(), ['All hands', 'Sup only', 'Viewer only'], 'admin ?all=true is the management view');
});

test('visibility: non-admins cannot widen the view with ?all=true and never see delivery stats', async () => {
  await publish({ audienceRoles: ['supervisor'], title: 'Sup only' }); await publish({ title: 'Gone' });
  const id = (await visible(admin, '?all=true')).find((a) => a.title === 'Gone').id;
  await call(app, admin.token, 'POST', `/announcements/${id}/retract`);
  const v = await visible(staff, '?all=true');
  assert.deepEqual(v.map((a) => a.title), []); 
  const s = await visible(sup, '?all=true');
  assert.deepEqual(s.map((a) => a.title), ['Sup only']); assert.equal(s[0].delivered, null); assert.equal(s[0].read, null);
});

test('expiry: an expired announcement disappears from callers’ lists but stays in the admin ?all=true view with status "expired"', async () => {
  const id = (await publish({ title: 'Short lived', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).json().id;
  assert.equal((await visible(staff)).length, 1);
  await db.execute(sql`update announcements set expires_at = now() - interval '1 minute' where id = ${id}`);
  assert.equal((await visible(staff)).length, 0); assert.equal((await visible(admin)).length, 0);
  const all = (await visible(admin, '?all=true'))[0]; assert.equal(all.status, 'expired'); assert.equal(all.id, id);
});

test('expiry validation: past or malformed dates are rejected on publish and on edit', async () => {
  assert.equal((await publish({ expiresAt: new Date(Date.now() - 1000).toISOString() })).json().error.code, 'INVALID_EXPIRY');
  assert.equal((await publish({ expiresAt: 'tomorrow-ish' })).statusCode, 400);
  const id = (await publish({})).json().id;
  const r = await call(app, admin.token, 'PATCH', `/announcements/${id}`, { expiresAt: new Date(Date.now() - 5000).toISOString() });
  assert.equal(r.statusCode, 422); assert.equal(r.json().error.code, 'INVALID_EXPIRY');
});

test('stats: admin ?all=true reports delivered and read per announcement', async () => {
  const id = (await publish({ title: 'Count me' })).json().id; await pump();
  await call(app, staff.token, 'POST', `/notifications/${(await inbox(staff))[0].id}/read`);
  await call(app, viewer.token, 'POST', `/notifications/${(await inbox(viewer))[0].id}/read`);
  const a = (await visible(admin, '?all=true')).find((x) => x.id === id);
  assert.equal(a.delivered, 5); assert.equal(a.read, 2); assert.equal(a.status, 'active');
  assert.equal(a.publishedBy.id, admin.userId); assert.ok(a.publishedBy.name);
  const other = (await publish({ title: 'Untouched' })).json();
  assert.deepEqual([other.delivered, other.read], [0, 0], 'nothing delivered before the worker runs');
});

test('retract: unread copies vanish from inboxes, read copies stay as history, the banner disappears, the unread counter drops', async () => {
  const id = (await publish({ title: 'Oops' })).json().id; await pump();
  await call(app, staff.token, 'POST', `/notifications/${(await inbox(staff))[0].id}/read`);
  assert.equal((await call(app, viewer.token, 'GET', '/notifications/unread-count')).json().count, 1);
  const r = await call(app, admin.token, 'POST', `/announcements/${id}/retract`); assert.equal(r.statusCode, 204);
  assert.equal((await inbox(staff)).length, 1, 'already read → kept');
  for (const s of [admin, sup, staff2, viewer]) assert.equal((await inbox(s)).length, 0, s.email);
  assert.equal((await call(app, viewer.token, 'GET', '/notifications/unread-count')).json().count, 0);
  assert.equal((await visible(viewer)).length, 0);
  const a = (await visible(admin, '?all=true'))[0]; assert.equal(a.status, 'retracted'); assert.ok(a.retractedAt);
  assert.equal(a.read, 1); assert.equal(a.delivered, 1, 'only the read copy remains');
  assert.equal((await auditRows(admin.orgId, 'announcement.retracted')).at(-1)!.entityId, id);
  assert.equal(((await auditRows(admin.orgId, 'announcement.retracted')).at(-1)!.next as any).unreadCopiesRemoved, 4);
});

test('retract twice → 409; edit after retract → 409; retract unknown → 404; retract before delivery delivers nothing', async () => {
  const id = (await publish({ title: 'Withdrawn early' })).json().id;
  assert.equal((await call(app, admin.token, 'POST', `/announcements/${id}/retract`)).statusCode, 204);
  assert.equal((await call(app, admin.token, 'POST', `/announcements/${id}/retract`)).json().error.code, 'ANNOUNCEMENT_RETRACTED');
  assert.equal((await call(app, admin.token, 'PATCH', `/announcements/${id}`, { title: 'x' })).json().error.code, 'ANNOUNCEMENT_RETRACTED');
  assert.equal((await call(app, admin.token, 'POST', `/announcements/${crypto.randomUUID()}/retract`)).statusCode, 404);
  await pump();
  for (const s of everyone.map((f) => f())) assert.equal((await inbox(s)).length, 0, 'the worker sees the retraction and drops it');
  assert.equal(sentMessages.filter((m) => m.subject === 'Withdrawn early').length, 0);
});

test('edit: title, body, severity and expiry can change (and expiry cleared with null); audit keeps previous/next', async () => {
  const id = (await publish({ title: 'v1', severity: 'info', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).json().id;
  const r = await call(app, admin.token, 'PATCH', `/announcements/${id}`, { title: 'v2', body: 'new body', severity: 'critical', expiresAt: null });
  assert.equal(r.statusCode, 200); assert.deepEqual([r.json().title, r.json().body, r.json().severity, r.json().expiresAt], ['v2', 'new body', 'critical', null]);
  const row = (await auditRows(admin.orgId, 'announcement.updated')).at(-1)!;
  assert.equal((row.previous as any).title, 'v1'); assert.equal((row.next as any).title, 'v2'); assert.equal((row.next as any).severity, 'critical');
  assert.equal((await call(app, admin.token, 'PATCH', `/announcements/${id}`, {})).statusCode, 400);
  assert.equal((await call(app, admin.token, 'PATCH', `/announcements/${id}`, { audienceRoles: ['viewer'] })).statusCode, 400, 'the audience is fixed at publish time');
});

test('permissions & tenancy: only admins manage; everyone reads; other orgs cannot see or touch announcements', async () => {
  for (const s of [sup, staff, viewer]) assert.equal((await publish({}, s.token)).statusCode, 403);
  const id = (await publish({ title: 'Mine' })).json().id;
  const rival = await registerOrg(app, 'Rival');
  assert.equal((await visible(rival, '?all=true')).length, 0);
  assert.equal((await call(app, rival.token, 'PATCH', `/announcements/${id}`, { title: 'hacked' })).statusCode, 404);
  assert.equal((await call(app, rival.token, 'POST', `/announcements/${id}/retract`)).statusCode, 404);
  assert.equal((await call(app, sup.token, 'POST', `/announcements/${id}/retract`)).statusCode, 403);
  await pump(); assert.equal((await inbox(rival)).length, 0);
});

test('validation: empty title/body, oversize, unknown role, unknown field are rejected', async () => {
  assert.equal((await publish({ title: '' })).statusCode, 400); assert.equal((await publish({ body: '' })).statusCode, 400);
  assert.equal((await publish({ title: 'x'.repeat(161) })).statusCode, 400); assert.equal((await publish({ body: 'x'.repeat(4001) })).statusCode, 400);
  assert.equal((await publish({ audienceRoles: ['owner'] })).statusCode, 400); assert.equal((await publish({ severity: 'loud' })).statusCode, 400);
  assert.equal((await publish({ publishedBy: admin.userId })).statusCode, 400);
  const r = await publish({ title: '  padded  ', body: '  text  ' }); assert.deepEqual([r.json().title, r.json().body], ['padded', 'text']);
});

test('audit: publish is logged with audience summary and e-mail flag', async () => {
  const a = (await publish({ audienceRoles: ['viewer'], severity: 'warning', sendEmail: true })).json();
  const row = (await auditRows(admin.orgId, 'announcement.published')).at(-1)!;
  assert.equal(row.entityId, a.id); assert.deepEqual(row.next, { title: 'Yard closed', severity: 'warning', audience: ['viewer'], email: true });
  await publish({}); assert.equal(((await auditRows(admin.orgId, 'announcement.published')).at(-1)!.next as any).audience, 'everyone');
});
