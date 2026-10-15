/** The trigger-maintained custody read-model (drizzle/manual/post/0150): always equals the ledger; backfills idempotently; the oracle catches drift. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { runMigrations } from '../scripts/migrate.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, mkItem, mkHolder, idem, type App, type Session } from './helpers.js';

let app: App; let admin: Session, staff: Session; let john: { id: string }, mary: { id: string };
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); admin = await registerOrg(app); staff = await createUser(app, admin, 'store_staff'); john = await mkHolder(app, staff.token, 'John'); mary = await mkHolder(app, staff.token, 'Mary'); });

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const tx = (op: string, body: object, token = staff.token) => callIdem(app, token, 'POST', `/transactions/${op}`, body, idem());
const balances = async () => rows(await db.execute(sql`select item_id, holder_id, quantity, issued_all, issued, returned from custody_balances order by item_id, holder_id`));
const mismatches = async () => (await findViolations(db)).filter((v) => v.check === 'custody_balances_mismatch');
const ties = (qty = 100) => mkItem(app, admin.token, { type: 'consumable', name: `Ties ${crypto.randomUUID().slice(0, 4)}`, openingQuantity: qty });

test('after a mixed workload the read-model equals the ledger: checkout, partial returns, corrections, consumption with a holder, batches', async () => {
  const a = await ties(), b = await ties(); const drill = await mkItem(app, admin.token, { type: 'asset', name: 'Drill' });
  await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 10 }); await tx('checkin', { itemId: a.id, holderId: john.id, quantity: 4 });
  const co = (await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 5 })).json().transaction.id;
  await tx('consume', { itemId: b.id, quantity: 3, holderId: mary.id }); await tx('consume', { itemId: b.id, quantity: 2 });
  await tx('checkout/batch', { holderId: mary.id, lines: [{ itemId: drill.id }, { itemId: b.id, quantity: 7 }] });
  assert.equal((await callIdem(app, admin.token, 'POST', `/transactions/${co}/correct`, { note: 'wrong holder' }, idem())).statusCode, 201);
  assert.deepEqual(await mismatches(), []);
  const jb = (await balances()).find((r) => r.item_id === a.id && r.holder_id === john.id)!;
  assert.deepEqual([jb.quantity, jb.issued, jb.returned, jb.issued_all], [6, 15, 4, 15], '10 + 5 issued, 4 back; the reversal of the 5 is a correction, so it is neither a return nor an issue');
  assert.deepEqual(await findViolations(db), []);
});

test('consumption without a holder and zero-custody rows create no balance rows', async () => {
  const a = await ties(); await tx('consume', { itemId: a.id, quantity: 5 }); await tx('restock', { itemId: a.id, quantity: 5 }, admin.token);
  assert.equal((await balances()).length, 0);
});

test('failed operations leave the read-model untouched', async () => {
  const a = await ties(5); await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 2 }); const before = await balances();
  assert.equal((await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 99 })).statusCode, 409);
  assert.equal((await tx('checkin', { itemId: a.id, holderId: john.id, quantity: 99 })).statusCode >= 400, true);
  assert.deepEqual(await balances(), before);
});

test('concurrent writes on the same (item, holder) cannot make the read-model drift', async () => {
  const a = await ties(1000);
  const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 3 === 2 ? tx('checkin', { itemId: a.id, holderId: john.id, quantity: 1 }) : tx('checkout', { itemId: a.id, holderId: john.id, quantity: 2 }))));
  assert.ok(rs.every((r) => r.statusCode < 500), rs.map((r) => r.statusCode).join());
  assert.deepEqual(await mismatches(), []); assert.deepEqual(await findViolations(db), []);
});

test('the Outstanding screen reads the read-model: quantities, issued/returned, FIFO due date and since come out identical to the ledger maths', async () => {
  const a = await ties(); const d1 = new Date(Date.now() + 2 * 86_400_000).toISOString(), d2 = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 10, dueAt: d1 }); await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 5, dueAt: d2 }); await tx('checkin', { itemId: a.id, holderId: john.id, quantity: 12 });
  const l = (await call(app, staff.token, 'GET', '/outstanding')).json().items.find((i: any) => i.item.id === a.id);
  assert.deepEqual([l.quantity, l.issuedQuantity, l.returnedQuantity, l.partialReturn, l.dueAt], [3, 15, 12, true, d2]); assert.ok(l.since);
});

test('oracle: detects a drifted quantity, a missing row and a phantom row', async () => {
  const a = await ties(); await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 4 }); assert.deepEqual(await mismatches(), []);
  await db.execute(sql`update custody_balances set quantity = quantity + 1`); assert.equal((await mismatches()).length, 1);
  await db.execute(sql`update custody_balances set quantity = quantity - 1`); assert.deepEqual(await mismatches(), []);
  await db.execute(sql`delete from custody_balances`); assert.equal((await mismatches()).length, 1, 'missing row');
  await runMigrations(process.env.DATABASE_URL!); assert.deepEqual(await mismatches(), [], 'the idempotent backfill repairs an empty table');
  const org = (await db.execute(sql`select org_id from custody_balances limit 1`)) as any;
  await db.execute(sql`insert into custody_balances (org_id, item_id, holder_id, quantity, issued_all, issued, returned) values (${rows(org)[0].org_id}, ${a.id}, ${mary.id}, 3, 3, 3, 0)`);
  assert.equal((await mismatches()).length, 1, 'phantom row');
});

test('backfill is idempotent: re-running the migration never double counts', async () => {
  const a = await ties(); await tx('checkout', { itemId: a.id, holderId: john.id, quantity: 4 }); const before = await balances();
  await runMigrations(process.env.DATABASE_URL!); await runMigrations(process.env.DATABASE_URL!);
  assert.deepEqual(await balances(), before); assert.deepEqual(await mismatches(), []);
});
