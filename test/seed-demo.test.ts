/** The demo seed is a product surface (sales demos, staging): it must work from an empty database, produce a CONSISTENT dataset, and be safe to re-run. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { processDomainEvents } from '../src/modules/notifications/service.js';
import { seedDemo, type DemoResult } from '../scripts/seed-demo.js';
import { makeApp, resetAll, flushMail, type App } from './helpers.js';

let app: App; let demo: DemoResult; const tok: Record<string, string> = {};
const get = async (who: string, url: string) => (await app.inject({ method: 'GET', url: `/v1${url}`, headers: { authorization: `Bearer ${tok[who]}` } })).json();
before(async () => {
  app = await makeApp(); await resetAll(app); demo = await seedDemo(app, db as never, flushMail); await processDomainEvents(db);
  for (const [k, email] of Object.entries(demo.users)) { const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: demo.slug, email, password: demo.password } }); assert.equal(r.statusCode, 200, `${k} can sign in`); tok[k] = r.json().token; }
});
after(async () => { await app.close(); });

test('all five roles can sign in with the documented credentials', () => assert.deepEqual(Object.keys(tok).sort(), ['admin', 'staff', 'staff2', 'supervisor', 'viewer']));

test('the dataset is consistent: the integrity oracle (stock, custody, states, read-model) finds nothing', async () => assert.deepEqual(await findViolations(db), []));

test('the demo tells a story on every screen: overdue, due soon, partial returns, low stock, near minimum, pending approval, a count, an announcement', async () => {
  const dash = await get('admin', '/dashboard');
  assert.ok(dash.overdue >= 3, `overdue ${dash.overdue}`); assert.ok(dash.lowStock >= 1, 'low stock'); assert.ok(dash.nearMinimum >= 1, 'near minimum'); assert.ok(dash.outstanding >= 8, `outstanding ${dash.outstanding}`);
  const out = (await get('viewer', '/outstanding?limit=100')).items as any[]; assert.ok(out.some((o) => o.partialReturn), 'a partial return'); assert.ok(out.some((o) => o.dueStatus === 'overdue') && out.some((o) => o.dueStatus === 'on_time'));
  assert.ok(out.some((o) => o.holder.kind === 'job_site') && out.some((o) => o.holder.kind === 'team') && out.some((o) => o.holder.kind === 'person'));
  const approvals = (await get('supervisor', '/approvals?status=pending&limit=50')).items as any[]; assert.ok(approvals.some((a) => a.operation === 'loss'), 'a loss awaiting approval');
  assert.equal((await get('viewer', '/announcements')).items.length, 1);
  assert.ok(((await get('supervisor', '/reconciliations?status=closed')).items as any[]).length >= 1, 'a closed shelf count');
  assert.equal(((await get('admin', '/collections')).shelves as any[]).length, 4, 'three shelves plus the default one');
  assert.ok(((await get('admin', '/items?status=under_repair')).items as any[]).length >= 1, 'an item flagged for inspection');
});

test('history spans about two weeks, oldest first by sequence, and every activity sentence is readable', async () => {
  const feed = (await get('supervisor', '/activity?limit=100')).items as any[]; const times = feed.map((e) => new Date(e.createdAt).getTime());
  assert.ok(Math.max(...times) - Math.min(...times) > 10 * 86_400_000, 'spread over ~2 weeks');
  assert.deepEqual(feed.map((e) => e.sequence), feed.map((e) => e.sequence).sort((a, b) => b - a));
  for (const e of feed) assert.ok(e.summary.length > 8 && !/undefined|null|\[object/.test(e.summary), e.summary);
  const dueAgo = ((await get('admin', '/overdue?limit=50')).items as any[]); assert.ok(dueAgo.every((o) => o.overdueByHours > 0));
});

test('notifications reached the right people (low stock routed to staff by the demo rule; announcement to everyone)', async () => {
  const n = async (who: string) => ((await get(who, '/notifications?limit=100')).items as any[]).map((x) => x.type);
  assert.ok((await n('staff')).includes('low_stock')); assert.ok((await n('viewer')).includes('announcement')); assert.ok(!(await n('viewer')).includes('low_stock'));
});

test('re-running is a safe no-op (no duplicate organization, no second history)', async () => {
  const again = await seedDemo(app, db as never, flushMail); assert.equal(again.skipped, true);
  assert.equal((await get('admin', '/items?limit=100')).items.length, 39, 'still the same 39-item catalogue');
  assert.equal((await get('admin', '/holders?limit=100')).items.length, 15, '10 named holders plus one person record per user');
});
