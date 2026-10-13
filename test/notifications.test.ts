import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { domainEvents, importJobs } from '../src/db/schema.js';
import { ts } from '../src/lib/sql.js';
import { getQueue } from '../src/lib/queue.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { auditIntegrity, purgeExpired } from '../src/modules/maintenance/jobs.js';
import { dispatchDueEmails } from '../src/modules/mail/outbox.js';
import { sentMessages } from '../src/modules/mail/mailer.js';
import { processDomainEvents, scanOverdue } from '../src/modules/notifications/service.js';
import { startWorkers } from '../src/worker.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, mkItem, mkHolder, multipart, idem, seededCatalog, type App, type Session } from './helpers.js';

let app: App;
let admin: Session, sup: Session, staff: Session, viewer: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetAll(app);
  admin = await registerOrg(app);
  sup = await createUser(app, admin, 'supervisor', 'Sam Supervisor');
  staff = await createUser(app, admin, 'store_staff', 'Stella Staff');
  viewer = await createUser(app, admin, 'viewer');
  sentMessages.length = 0;
});

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const get = async (token: string, url: string) => (await call(app, token, 'GET', url)).json();
const tx = (token: string, op: string, body: object, key = idem()) => callIdem(app, token, 'POST', `/transactions/${op}`, body, key);
const notes = async (token: string, q = '') => (await get(token, `/notifications?limit=100${q}`)).items as Array<{ id: string; type: string; title: string; body: string; read: boolean }>;
const pump = async () => { const e = await processDomainEvents(db); await dispatchDueEmails(db); return e; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('low stock: reviewers are notified in-app once per crossing; staff and viewers are not; no e-mail unless the org enables it', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', name: 'Welding rods', openingQuantity: 10, minQuantity: 5, unit: 'boxes' });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 6 });
  const r = await pump();
  assert.equal(r.processed, 1);
  for (const t of [admin, sup]) {
    const n = (await notes(t.token))[0];
    assert.deepEqual([n.type, n.title], ['low_stock', 'Low stock: Welding rods (STK-0001)']);
    assert.match(n.body, /down to 4 boxes \(minimum 5\)/);
  }
  assert.equal((await notes(staff.token)).length, 0);
  assert.equal((await notes(viewer.token)).length, 0);
  assert.equal(sentMessages.filter((m) => /Low stock/.test(m.subject)).length, 0, 'low_stock e-mail is off by default');
  assert.equal((await pump()).processed, 0, 'events are processed exactly once');

  await call(app, admin.token, 'PATCH', '/organization/settings', { notificationEmailTypes: ['low_stock'] });
  await tx(staff.token, 'restock', { itemId: cons.id, quantity: 20 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 20 });
  await pump();
  const mails = sentMessages.filter((m) => /Low stock/.test(m.subject));
  assert.deepEqual(mails.map((m) => m.to).sort(), [admin.email, sup.email].sort(), 'e-mail to reviewers once the org enables it');
  assert.match(mails[0].text, /Welding rods/);
});

test('e-mail bodies are HTML-escaped (item names are user input)', async () => {
  await call(app, admin.token, 'PATCH', '/organization/settings', { notificationEmailTypes: ['low_stock'] });
  const evil = await mkItem(app, admin.token, { type: 'consumable', name: '<img src=x onerror=alert(1)>', openingQuantity: 10, minQuantity: 5 });
  await tx(staff.token, 'consume', { itemId: evil.id, quantity: 6 });
  await pump();
  const m = sentMessages.find((x) => /Low stock/.test(x.subject))!;
  assert.ok(m.html && !m.html.includes('<img'), 'no raw markup in the HTML part');
  assert.ok(m.html!.includes('&lt;img'));
});

test('approvals: reviewers hear about a request (not the requester); the requester hears the decision', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  const req = (await tx(staff.token, 'adjust', { itemId: cons.id, quantityDelta: -2, reason: 'count_correction' })).json().approval;
  await pump();
  for (const t of [admin, sup]) assert.equal((await notes(t.token)).filter((n) => n.type === 'approval_pending').length, 1);
  assert.equal((await notes(staff.token)).filter((n) => n.type === 'approval_pending').length, 0);
  assert.ok(sentMessages.some((m) => m.to === sup.email && m.subject === 'Approval needed'), 'approval_pending e-mails by default');

  await callIdem(app, sup.token, 'POST', `/approvals/${req.id}/reject`, { note: 'Recount first' });
  await pump();
  const n = (await notes(staff.token)).find((x) => x.type === 'approval_decided')!;
  assert.equal(n.title, 'Your request was rejected');
  assert.match(n.body, /Recount first/);
  assert.equal((await notes(admin.token)).filter((x) => x.type === 'approval_decided').length, 0);
});

test('a poison event cannot block the queue and is parked after its retry budget; good events still flow', async () => {
  await db.insert(domainEvents).values({ orgId: admin.orgId, type: 'stock.low', payload: { itemId: 'not-a-uuid', balance: 1, minimum: 2 } });
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5, minQuantity: 3 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 3 });
  const first = await processDomainEvents(db);
  assert.deepEqual([first.processed, first.failed], [1, 1]);
  assert.equal((await notes(admin.token)).length, 1, 'the good event was delivered despite the poison one before it');
  for (let i = 0; i < 8; i++) await processDomainEvents(db);
  const [bad] = await db.select().from(domainEvents).where(eq(domainEvents.type, 'stock.low')).orderBy(domainEvents.createdAt).limit(1);
  assert.equal(bad.attempts, 8);
  assert.ok(bad.processedAt, 'parked, not retried forever');
  assert.ok(bad.lastError);
  assert.equal((await processDomainEvents(db)).failed, 0);
});

test('overdue scan notifies once per overdue episode; returning and re-issuing starts a new episode', async () => {
  const john = await mkHolder(app, staff.token, 'John Okafor');
  const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Makita Drill', expectedReturnHours: 4 });
  await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id });
  assert.equal(await scanOverdue(db), 0, 'not yet due');
  await db.execute(sql`update items set due_at = now() - interval '2 hours' where id = ${drill.id}`);
  assert.equal(await scanOverdue(db), 1);
  assert.equal(await scanOverdue(db), 0, 'same episode: deduplicated');
  await pump();
  const n = (await notes(sup.token)).find((x) => x.type === 'overdue_checkout')!;
  assert.match(n.title, /Overdue: Makita Drill/);
  assert.match(n.body, /John Okafor/);
  assert.ok(sentMessages.some((m) => m.to === sup.email && /Overdue/.test(m.subject)), 'overdue e-mails by default');

  await tx(staff.token, 'checkin', { itemId: drill.id });
  await tx(staff.token, 'checkout', { itemId: drill.id, holderId: john.id });
  await db.execute(sql`update items set due_at = now() - interval '1 hour' where id = ${drill.id}`);
  assert.equal(await scanOverdue(db), 1, 'a new overdue episode notifies again');
});

test('preferences: per-user in-app mute and e-mail override beat the org default; effective values are reported', async () => {
  await call(app, admin.token, 'PATCH', '/organization/settings', { notificationEmailTypes: ['low_stock'] });
  assert.equal((await call(app, sup.token, 'PUT', '/notifications/preferences/low_stock', { inApp: false, email: false })).statusCode, 204);
  assert.equal((await call(app, sup.token, 'PUT', '/notifications/preferences/bogus', { inApp: false })).statusCode, 400);
  const prefs = (await get(sup.token, '/notifications/preferences')).items;
  assert.equal(prefs.length, 8, 'six alert types + announcements + cycle-count reminders');
  assert.deepEqual(prefs.find((p: any) => p.type === 'low_stock'), { type: 'low_stock', inApp: false, email: false, emailIsOrgDefault: false });
  assert.deepEqual(prefs.find((p: any) => p.type === 'overdue_checkout'), { type: 'overdue_checkout', inApp: true, email: false, emailIsOrgDefault: true });
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10, minQuantity: 5 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 6 });
  await pump();
  assert.equal((await notes(sup.token)).length, 0, 'muted in-app');
  assert.equal((await notes(admin.token)).length, 1);
  assert.deepEqual(sentMessages.filter((m) => /Low stock/.test(m.subject)).map((m) => m.to), [admin.email], 'the supervisor opted out of e-mail; the admin follows the org default');
  await call(app, sup.token, 'PUT', '/notifications/preferences/low_stock', { email: null });
  assert.equal((await get(sup.token, '/notifications/preferences')).items.find((p: any) => p.type === 'low_stock').emailIsOrgDefault, true);
});

test('notification API: private to each user; unread count; mark one / all read; pagination; auth required', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 100, minQuantity: 50 });
  for (let i = 0; i < 3; i++) { await tx(staff.token, 'consume', { itemId: cons.id, quantity: i === 0 ? 60 : 100 }); await tx(staff.token, 'restock', { itemId: cons.id, quantity: 100 }); } // each pass crosses down through the minimum
  await pump();
  const mine = await notes(sup.token);
  assert.equal(mine.length, 3);
  assert.equal((await get(sup.token, '/notifications/unread-count')).count, 3);
  assert.equal((await call(app, null, 'GET', '/notifications')).statusCode, 401);

  const page1 = await get(sup.token, '/notifications?limit=2');
  assert.equal(page1.items.length, 2);
  const page2 = await get(sup.token, `/notifications?limit=2&cursor=${page1.nextCursor}`);
  assert.deepEqual([page2.items.length, page2.nextCursor], [1, null]);
  assert.equal(new Set([...page1.items, ...page2.items].map((n: any) => n.id)).size, 3);

  assert.equal((await call(app, admin.token, 'POST', `/notifications/${mine[0].id}/read`)).statusCode, 404, "cannot touch someone else's notification");
  assert.equal((await call(app, sup.token, 'POST', `/notifications/${mine[0].id}/read`)).statusCode, 204);
  assert.equal((await call(app, sup.token, 'POST', `/notifications/${mine[0].id}/read`)).statusCode, 204, 'idempotent');
  assert.equal((await get(sup.token, '/notifications/unread-count')).count, 2);
  assert.equal((await notes(sup.token, '&unread=true')).length, 2);
  assert.equal((await call(app, sup.token, 'POST', '/notifications/read-all')).json().marked, 2);
  assert.equal((await get(sup.token, '/notifications/unread-count')).count, 0);
  assert.equal((await get(admin.token, '/notifications/unread-count')).count, 3, 'other users unaffected');
  const other = await registerOrg(app, 'Rival');
  assert.equal((await notes(other.token)).length, 0);
});

test('housekeeping removes expired operational data and NEVER touches the immutable ledger or audit log', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 5 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 1 });
  await db.execute(sql`update sessions set expires_at = now() - interval '1 day' where user_id = ${viewer.userId}`);
  await db.execute(sql`update idempotency_keys set expires_at = now() - interval '1 day'`);
  await db.execute(sql`update auth_tokens set expires_at = now() - interval '30 days'`);
  const up = (() => { const m = multipart(Buffer.from('Name,Type\nA,asset\n'), 'a.csv', 'text/csv'); return app.inject({ method: 'POST', url: '/v1/imports', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${admin.token}` } }); })();
  const job = (await up).json().import.id;
  await db.update(importJobs).set({ status: 'committing', startedAt: new Date(Date.now() - 3600_000) }).where(eq(importJobs.id, job));
  const before = rows(await db.execute(sql`select (select count(*) from transactions)::int t, (select count(*) from audit_events)::int a`))[0];
  const r = await purgeExpired(db);
  assert.ok(r.sessions >= 1 && r.authTokens >= 1);
  assert.equal(r.stuckImports, 1);
  assert.equal((await call(app, viewer.token, 'GET', '/auth/me')).statusCode, 401, 'expired session is gone');
  assert.equal((await call(app, admin.token, 'GET', '/auth/me')).statusCode, 200, 'live sessions are untouched');
  assert.equal((await get(admin.token, `/imports/${job}`)).import.status, 'failed', 'a stuck import becomes retryable');
  const after = rows(await db.execute(sql`select (select count(*) from transactions)::int t, (select count(*) from audit_events)::int a`))[0];
  assert.deepEqual(after, before, 'ledger and audit log are append-only: housekeeping cannot shrink them');
});

test('the integrity audit is silent on a healthy ledger and loud (metric + log) when state drifts from history', async () => {
  const cons = await mkItem(app, admin.token, { type: 'consumable', openingQuantity: 10 });
  await tx(staff.token, 'consume', { itemId: cons.id, quantity: 2 });
  assert.equal(await auditIntegrity(db), 0);
  assert.match((await app.inject('/metrics')).body, /storekeeper_integrity_violations 0/);
  await db.execute(sql`update items set quantity_available = 99 where id = ${cons.id}`); // tampering that bypasses the application
  const logged: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => { logged.push(String(a[0])); };
  try { assert.equal(await auditIntegrity(db), 1); } finally { console.error = orig; }
  assert.match(logged[0], /LEDGER INTEGRITY VIOLATIONS/);
  assert.match((await app.inject('/metrics')).body, /storekeeper_integrity_violations 1/);
  const v = await findViolations(db);
  assert.deepEqual([v[0].check, v[0].detail], ['stock_matches_ledger', { quantityAvailable: 99, ledgerSum: 8 }]);
});

test('END-TO-END with a real BullMQ worker: a large import commits off-request, and scheduled jobs deliver notifications by themselves', async () => {
  const worker = await startWorkers({ schedule: true });
  try {
    const big = ['Name,Type,SKU,Qty', ...Array.from({ length: 520 }, (_, i) => `Bulk ${i},consumable,W-${i},${i + 1}`)].join('\n');
    const m = multipart(Buffer.from(big), 'big.csv', 'text/csv');
    const up = (await app.inject({ method: 'POST', url: '/v1/imports', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${admin.token}` } })).json();
    await call(app, admin.token, 'POST', `/imports/${up.import.id}/validate`, { mapping: { name: 'Name', type: 'Type', sku: 'SKU', quantity: 'Qty' }, defaults: { categoryId: (await seededCatalog(app, admin.token)).categoryId } });
    assert.equal((await call(app, admin.token, 'POST', `/imports/${up.import.id}/commit`)).statusCode, 202);

    const low = await mkItem(app, admin.token, { type: 'consumable', name: 'Scheduled', openingQuantity: 5, minQuantity: 3 });
    await tx(staff.token, 'consume', { itemId: low.id, quantity: 3 });

    let status = ''; let notified = false;
    for (let i = 0; i < 60 && !(status === 'completed' && notified); i++) {
      status = (await get(admin.token, `/imports/${up.import.id}`)).import.status;
      notified = (await notes(sup.token)).some((n) => n.type === 'low_stock');
      if (!(status === 'completed' && notified)) await sleep(500);
    }
    assert.equal(status, 'completed', 'the worker finished the import');
    assert.ok(notified, 'the scheduled event job fanned out the notification with nobody calling it');
    assert.equal(rows(await db.execute(sql`select count(*)::int n from items where name like 'Bulk %'`))[0].n, 520);
    assert.deepEqual(await findViolations(db), []);
  } finally {
    await worker.close();
    await getQueue('imports').obliterate({ force: true }).catch(() => {});
    await getQueue('maintenance').obliterate({ force: true }).catch(() => {});
  }
});
void ts;
