/** Cycle-count reminders and the shelf count clock (lastCountedAt / nextCountDueAt). Time travel is done by backdating rows, never by sleeping. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { processDomainEvents, scanCycleCounts } from '../src/modules/notifications/service.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, mkShelf, mkCategory, mkItem, auditRows, type App, type Session } from './helpers.js';

let app: App; let admin: Session, sup: Session, staff: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff'); });

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const DAY = 86_400_000;
const backdate = (shelfId: string, days: number) => db.execute(sql`update shelves set created_at = now() - make_interval(days => ${days}) where id = ${shelfId}`);
const events = async () => rows(await db.execute(sql`select payload, dedupe_key from domain_events where type = 'shelf.count_due' order by created_at`));
const noteTo = async (s: Session) => ((await call(app, s.token, 'GET', '/notifications?limit=100')).json().items as any[]).filter((n) => n.type === 'cycle_count_due');
const shelfView = async (id: string) => (await call(app, admin.token, 'GET', '/shelves?includeArchived=true')).json().items.find((s: any) => s.id === id);

/** A shelf with one category and one item, so it is "countable". */
async function stocked(over: Record<string, unknown> = { cycleCountDays: 7 }) {
  const shelf = await mkShelf(app, admin.token, { name: `Shelf ${crypto.randomUUID().slice(0, 5)}`, ...over });
  const cat = await mkCategory(app, admin.token, { shelfId: shelf.id, name: `Cat ${crypto.randomUUID().slice(0, 5)}` }); const item = await mkItem(app, admin.token, { categoryId: cat.id, type: 'consumable', openingQuantity: 5 });
  return { shelf, cat, item };
}
const countShelf = async (shelfId: string, token = sup.token) => {
  const r = (await callIdem(app, token, 'POST', '/reconciliations', { scope: 'shelf', scopeId: shelfId })).json();
  const closed = await callIdem(app, token, 'POST', `/reconciliations/${r.id}/close`, {}); assert.equal(closed.statusCode, 200, closed.body); return r.id as string;
};

test('no cycle configured → never a reminder, however old the shelf; nextCountDueAt is null', async () => {
  const { shelf } = await stocked({}); await backdate(shelf.id, 400);
  assert.equal(await scanCycleCounts(db), 0);
  assert.equal((await shelfView(shelf.id)).nextCountDueAt, null);
});

test('a shelf that is not yet due: no reminder, and nextCountDueAt = created + interval', async () => {
  const { shelf } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 5);
  assert.equal(await scanCycleCounts(db), 0);
  const v = await shelfView(shelf.id);
  assert.equal(v.lastCountedAt, null);
  assert.ok(Math.abs(new Date(v.nextCountDueAt).getTime() - (new Date(v.createdAt).getTime() + 7 * DAY)) < 1000);
});

test('due shelf: the scan emits ONE event, repeated scans are no-ops (one reminder per cycle), and the right people are notified', async () => {
  const { shelf } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 8);
  assert.equal(await scanCycleCounts(db), 1);
  assert.equal(await scanCycleCounts(db), 0); assert.equal(await scanCycleCounts(db), 0);
  const ev = await events(); assert.equal(ev.length, 1); assert.deepEqual([ev[0].payload.shelfId, ev[0].payload.days, ev[0].payload.lastCountedAt], [shelf.id, 7, null]);
  assert.equal((await processDomainEvents(db)).processed, 1);
  for (const s of [admin, sup]) { const n = await noteTo(s); assert.equal(n.length, 1, s.email); assert.match(n[0].title, /^Count due: Shelf /); assert.match(n[0].body, /every 7 days; never counted/); }
  assert.equal((await noteTo(staff)).length, 0);
  assert.equal(await scanCycleCounts(db), 0, 'still one reminder after delivery');
});

test('not for shelves that hold nothing: empty shelf, shelf whose only item is archived, archived shelf', async () => {
  const empty = await mkShelf(app, admin.token, { name: 'Empty', cycleCountDays: 1 }); await backdate(empty.id, 30);
  const { shelf: s2, item } = await stocked({ cycleCountDays: 1 }); await backdate(s2.id, 30);
  assert.equal(await scanCycleCounts(db), 1, 'only s2 qualifies so far'); await db.execute(sql`delete from domain_events`);
  assert.equal((await callIdem(app, admin.token, 'POST', `/items/${item.id}/archive`, {})).statusCode, 200);
  assert.equal(await scanCycleCounts(db), 0, 'archived items do not count as stock to count');
  const { shelf: s3 } = await stocked({ cycleCountDays: 1 }); await backdate(s3.id, 30);
  assert.equal((await call(app, admin.token, 'POST', `/shelves/${s3.id}/archive`)).statusCode, 409, 'the API itself refuses to archive a shelf that still holds items');
  await db.execute(sql`update shelves set archived_at = now() where id = ${s3.id}`); // isolate the archived_at predicate of the scan
  assert.equal(await scanCycleCounts(db), 0);
});

test('closing a SHELF count resets the clock; the next reminder comes one full interval later, with a new dedupe key', async () => {
  const { shelf } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 8);
  await scanCycleCounts(db); const firstKey = (await events())[0].dedupe_key;
  const rid = await countShelf(shelf.id);
  const v = await shelfView(shelf.id);
  assert.ok(v.lastCountedAt); assert.ok(Math.abs(new Date(v.nextCountDueAt).getTime() - (new Date(v.lastCountedAt).getTime() + 7 * DAY)) < 1000);
  assert.equal(await scanCycleCounts(db), 0, 'freshly counted → not due');
  await db.execute(sql`update reconciliations set closed_at = now() - interval '10 days' where id = ${rid}`);
  assert.equal(await scanCycleCounts(db), 1, 'a new cycle has elapsed');
  const ev = await events(); assert.equal(ev.length, 2); assert.notEqual(ev[1].dedupe_key, firstKey); assert.ok(ev[1].payload.lastCountedAt);
  await processDomainEvents(db);
  const n = await noteTo(admin); assert.equal(n.length, 2); assert.ok(n.some((x) => /never counted/.test(x.body))); assert.ok(n.some((x) => /last counted \d{4}-\d{2}-\d{2}/.test(x.body)), 'the second reminder names the last count date');
});

test('only CLOSED SHELF-scope counts reset the clock: open shelf counts, category counts and item counts do not', async () => {
  const { shelf, cat, item } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 8);
  await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'shelf', scopeId: shelf.id }); // left open
  const c = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'category', scopeId: cat.id })).json(); await callIdem(app, sup.token, 'POST', `/reconciliations/${c.id}/close`, {});
  const i = (await callIdem(app, sup.token, 'POST', '/reconciliations', { scope: 'item', scopeId: item.id })).json(); await callIdem(app, sup.token, 'POST', `/reconciliations/${i.id}/close`, {});
  assert.equal((await shelfView(shelf.id)).lastCountedAt, null);
  assert.equal(await scanCycleCounts(db), 1, 'still due');
});

test('a count closed on shelf A does not affect shelf B', async () => {
  const a = await stocked({ cycleCountDays: 7 }); const b = await stocked({ cycleCountDays: 7 });
  await backdate(a.shelf.id, 8); await backdate(b.shelf.id, 8); await countShelf(a.shelf.id);
  assert.equal(await scanCycleCounts(db), 1); assert.equal((await events())[0].payload.shelfId, b.shelf.id);
});

test('documented behaviour: closing a shelf count with ZERO items counted still resets the clock (see continuation notes — product decision)', async () => {
  const { shelf } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 8);
  await countShelf(shelf.id);
  assert.equal(await scanCycleCounts(db), 0);
});

test('changing the interval: lengthening silences a due shelf; shortening makes a fresh one due, with its own dedupe key', async () => {
  const { shelf } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 8);
  assert.equal(await scanCycleCounts(db), 1);
  assert.equal((await call(app, admin.token, 'PATCH', `/shelves/${shelf.id}`, { cycleCountDays: 30 })).statusCode, 200);
  assert.equal(await scanCycleCounts(db), 0);
  assert.equal((await call(app, admin.token, 'PATCH', `/shelves/${shelf.id}`, { cycleCountDays: 3 })).statusCode, 200);
  assert.equal(await scanCycleCounts(db), 1, 'a different due instant is a different cycle');
  assert.equal((await call(app, admin.token, 'PATCH', `/shelves/${shelf.id}`, { cycleCountDays: null })).statusCode, 200);
  assert.equal((await shelfView(shelf.id)).nextCountDueAt, null); assert.equal(await scanCycleCounts(db), 0);
});

test('validation: the interval must be a whole number of days from 1 to 365 (null clears)', async () => {
  for (const bad of [0, -1, 366, 1.5, '7']) assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: `Bad ${String(bad)}`, cycleCountDays: bad })).statusCode, 400, String(bad));
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Edge 365', cycleCountDays: 365 })).statusCode, 201);
  assert.equal((await call(app, admin.token, 'POST', '/shelves', { name: 'Edge 1', cycleCountDays: 1 })).statusCode, 201);
});

test('routing: the reminder follows the org’s notification rule for cycle_count_due', async () => {
  assert.equal((await call(app, admin.token, 'PUT', '/organization/notification-rules/cycle_count_due', { roles: ['store_staff'] })).statusCode, 204);
  const { shelf } = await stocked({ cycleCountDays: 7 }); await backdate(shelf.id, 8);
  await scanCycleCounts(db); await processDomainEvents(db);
  assert.equal((await noteTo(staff)).length, 1); assert.equal((await noteTo(admin)).length, 0); assert.equal((await noteTo(sup)).length, 0);
});

test('tenancy: each organization’s shelves are scanned independently and notify only their own people', async () => {
  const rival = await registerOrg(app, 'Rival');
  const mine = await stocked({ cycleCountDays: 7 }); await backdate(mine.shelf.id, 8);
  const shelf = await mkShelf(app, rival.token, { name: 'Rival shelf', cycleCountDays: 7 }); const cat = await mkCategory(app, rival.token, { shelfId: shelf.id, name: 'Rival cat' }); await mkItem(app, rival.token, { categoryId: cat.id, type: 'consumable', openingQuantity: 2 }); await backdate(shelf.id, 8);
  assert.equal(await scanCycleCounts(db), 2); await processDomainEvents(db);
  assert.equal((await noteTo(admin)).length, 1); assert.equal((await noteTo(rival)).length, 1);
  assert.match((await noteTo(rival))[0].title, /Rival shelf/); assert.doesNotMatch((await noteTo(admin))[0].title, /Rival/);
});

test('the shelf list exposes the clock for every shelf; the interval change is audited', async () => {
  const { shelf } = await stocked({ cycleCountDays: 14 });
  await call(app, admin.token, 'PATCH', `/shelves/${shelf.id}`, { cycleCountDays: 21 });
  const row = (await auditRows(admin.orgId, 'shelf.updated')).at(-1)!; assert.equal((row.previous as any).cycleCountDays, 14); assert.equal((row.next as any).cycleCountDays, 21);
  const v = await shelfView(shelf.id); assert.equal(v.cycleCountDays, 21); assert.ok(v.nextCountDueAt);
});
