import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql, eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { importJobs } from '../src/db/schema.js';
import { findViolations } from '../src/modules/integrity/service.js';
import { getQueue } from '../src/lib/queue.js';
import { setBreaker } from '../src/lib/resilience/circuit.js';
import { loadActor, runCommit } from '../src/modules/imports/service.js';
import { makeApp, resetAll, registerOrg, call, createUser, multipart, mkItem, seededCatalog, type App, type Session } from './helpers.js';

let app: App;
let admin: Session;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); admin = await registerOrg(app); });

const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>;
const upload = (token: string, csv: string | Buffer, filename = 'items.csv') => {
  const m = multipart(Buffer.isBuffer(csv) ? csv : Buffer.from(csv), filename, 'text/csv');
  return app.inject({ method: 'POST', url: '/v1/imports', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${token}` } });
};
/** Every item needs a category: unless a test says otherwise, rows with no category use the seeded one and new categories go on the seeded shelf. */
const validate = async (token: string, id: string, body: Record<string, unknown>) => {
  const c = await seededCatalog(app, token);
  return call(app, token, 'POST', `/imports/${id}/validate`, { defaults: { categoryId: c.categoryId, shelfId: c.shelfId }, ...body });
};
const commit = (token: string, id: string) => call(app, token, 'POST', `/imports/${id}/commit`);
const MAP = { name: 'Name', type: 'Type', sku: 'SKU', quantity: 'Qty', category: 'Category', minQuantity: 'Min' };
const CSV = [
  'Name,Type,SKU,Qty,Category,Min',
  'Hex bolts M8,consumable,BOLT-M8,500,Fasteners,100',
  'Makita Drill,asset,DRL-18V,,Power Tools,',
  'Safety gloves,consumable,GLV-L,40,PPE,10',
].join('\r\n');

test('permissions: admin only by default; staff when the org enables item management; viewers never', async () => {
  const staff = await createUser(app, admin, 'store_staff');
  const viewer = await createUser(app, admin, 'viewer');
  assert.equal((await upload(staff.token, CSV)).statusCode, 403);
  assert.equal((await upload(viewer.token, CSV)).statusCode, 403);
  assert.equal((await upload(admin.token, CSV)).statusCode, 201);
  await call(app, admin.token, 'PATCH', '/organization/settings', { staffCanManageItems: true });
  assert.equal((await upload(staff.token, CSV)).statusCode, 201);
  assert.equal((await call(app, null, 'POST', '/imports')).statusCode, 401);
});

test('upload parsing: headers, suggested mapping, BOM/CRLF/quoted commas; hostile files are refused', async () => {
  const bom = '\uFEFFName,Type,SKU,Qty\r\n"Bolts, M8 (zinc)",consumable,B-1,10\r\n';
  const r = await upload(admin.token, bom);
  assert.equal(r.statusCode, 201);
  assert.deepEqual(r.json().headers, ['Name', 'Type', 'SKU', 'Qty'], 'BOM stripped');
  assert.deepEqual(r.json().suggestedMapping, { name: 'Name', type: 'Type', sku: 'SKU', quantity: 'Qty' });
  assert.equal(r.json().sample[0][0], 'Bolts, M8 (zinc)', 'quoted comma preserved');
  assert.equal((await upload(admin.token, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]))).json().error.code, 'NOT_CSV');
  assert.equal((await upload(admin.token, 'Name,Type\n')).json().error.code, 'EMPTY_CSV');
  assert.equal((await upload(admin.token, 'Name,Name\nA,B\n')).json().error.code, 'BAD_HEADERS');
  assert.equal((await upload(admin.token, 'Name,Type\n"unclosed,asset\n')).json().error.code, 'INVALID_CSV');
  assert.equal((await upload(admin.token, 'Name,Type\n' + 'x,asset\n'.repeat(10_001))).json().error.code, 'TOO_MANY_ROWS');
  assert.equal((await upload(admin.token, 'Name\n' + 'x'.repeat(6 * 1024 * 1024))).statusCode, 413);
});

test('validation preview: row-level problems, duplicates in the file and against existing items; nothing is written', async () => {
  await mkItem(app, admin.token, { type: 'consumable', sku: 'EXISTING-1', openingQuantity: 1 });
  const csv = [
    'Name,Type,SKU,Qty,Category,Min',
    'Good bolts,consumable,B-1,50,,5',
    ',consumable,B-2,5,,',                  // 3: no name
    'Odd type,gadget,B-3,5,,',              // 4: bad type
    'Neg qty,consumable,B-4,-3,,',          // 5: bad number
    'Many drills,asset,D-1,5,,',            // 6: asset qty > 1
    'Asset min,asset,D-2,,,4',              // 7: min on asset
    'Dup in file,consumable,B-1,5,,',       // 8: duplicate of row 2
    'Dup existing,consumable,EXISTING-1,5,,', // 9
    'New cat,consumable,B-5,5,Mystery,',    // 10: unknown category
  ].join('\n');
  const up = (await upload(admin.token, csv)).json();
  assert.equal((await validate(admin.token, up.import.id, { mapping: { name: 'Nope', type: 'Type' } })).json().error.code, 'UNKNOWN_COLUMN');
  assert.equal((await validate(admin.token, up.import.id, { mapping: { type: 'Type' } })).json().error.code, 'NAME_NOT_MAPPED');
  const v = await validate(admin.token, up.import.id, { mapping: MAP });
  assert.equal(v.statusCode, 200);
  const s = v.json().summary;
  assert.deepEqual([s.total, s.valid, s.invalid, s.duplicates], [9, 1, 6, 2]);
  const by = (row: number) => s.issues.filter((i: any) => i.row === row).map((i: any) => i.code);
  assert.deepEqual(by(3), ['NAME_REQUIRED']);
  assert.deepEqual(by(4), ['TYPE_REQUIRED']);
  assert.deepEqual(by(5), ['INVALID_NUMBER']);
  assert.deepEqual(by(6), ['ASSET_QUANTITY']);
  assert.deepEqual(by(7), ['NOT_APPLICABLE']);
  assert.deepEqual(by(8), ['DUPLICATE_IN_FILE']);
  assert.deepEqual(by(9), ['DUPLICATE_SKU']);
  assert.deepEqual(by(10), ['UNKNOWN_CATEGORY']);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from items`))[0].n, 1, 'validation writes no items');
  const ok = await validate(admin.token, up.import.id, { mapping: MAP, createCategories: true });
  assert.equal(ok.json().summary.invalid, 5, 'creating categories resolves the unknown-category row');
  assert.equal((await validate(admin.token, up.import.id, { mapping: { name: 'Name' } })).json().error.code, 'TYPE_NOT_MAPPED');
  assert.equal((await validate(admin.token, up.import.id, { mapping: { name: 'Name' }, defaults: { type: 'consumable' } })).statusCode, 200, 'a default type can stand in for a type column');
});

test('commit: items created with opening balances in the ledger; categories created; duplicates skipped; invalid rows reported; integrity holds', async () => {
  const up = (await upload(admin.token, CSV + '\r\n=cmd|calc,consumable,GLV-L,5,PPE,\r\nBad,consumable,X-1,abc,PPE,')).json();
  await validate(admin.token, up.import.id, { mapping: MAP, createCategories: true });
  const c = await commit(admin.token, up.import.id);
  assert.equal(c.statusCode, 200);
  assert.deepEqual(c.json().result, { imported: 3, skipped: 1, failed: 1 });
  assert.equal(c.json().import.status, 'completed');

  const list = (await call(app, admin.token, 'GET', '/items?limit=50')).json().items;
  assert.equal(list.length, 3);
  const bolts = list.find((i: any) => i.sku === 'BOLT-M8');
  assert.deepEqual([bolts.type, bolts.quantityAvailable, bolts.minQuantity, bolts.categoryName], ['consumable', 500, 100, 'Fasteners']);
  assert.equal(list.find((i: any) => i.sku === 'DRL-18V').assetState, 'available');
  const ledger = rows(await db.execute(sql`select type, stock_delta, balance_after from transactions where item_id = ${bolts.id}`));
  assert.deepEqual([ledger[0].type, ledger[0].stock_delta, ledger[0].balance_after], ['create', 500, 500], 'opening balance is a ledger fact');
  assert.deepEqual((await call(app, admin.token, 'GET', '/categories')).json().items.map((x: any) => x.name).sort(), ['Fasteners', 'General', 'PPE', 'Power Tools']);

  const err = await call(app, admin.token, 'GET', `/imports/${up.import.id}/errors`);
  assert.match(String(err.headers['content-type']), /text\/csv/);
  assert.match(err.body, /Row,Field,Status,Code,Problem/);
  assert.match(err.body, /DUPLICATE_SKU|DUPLICATE_IN_FILE|SKU_TAKEN/);
  assert.match(err.body, /INVALID_NUMBER/);
  assert.deepEqual(await findViolations(db), []);
  const audits = rows(await db.execute(sql`select action from audit_events where action like 'import.%' order by seq`));
  assert.deepEqual(audits.map((a) => a.action), ['import.uploaded', 'import.validated', 'import.committed']);
});

test('commit is idempotent per row: re-running an already-applied import creates nothing twice; a completed import cannot be re-committed', async () => {
  const up = (await upload(admin.token, CSV)).json();
  await validate(admin.token, up.import.id, { mapping: MAP, createCategories: true });
  assert.equal((await commit(admin.token, up.import.id)).json().result.imported, 3);
  assert.equal((await commit(admin.token, up.import.id)).json().error.code, 'IMPORT_COMPLETED');

  // Simulate a crash after the rows were created but before the job was marked completed.
  await db.update(importJobs).set({ status: 'failed' }).where(eq(importJobs.id, up.import.id));
  const again = await commit(admin.token, up.import.id);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json().result, { imported: 3, skipped: 0, failed: 0 }, 'rows recognised by their key, not recreated');
  assert.equal(rows(await db.execute(sql`select count(*)::int n from items`))[0].n, 3);
  assert.equal(rows(await db.execute(sql`select count(*)::int n from transactions where type = 'create'`))[0].n, 3);
  assert.deepEqual(await findViolations(db), []);
});

test('commit requires validation; concurrent commits: exactly one runs', async () => {
  const up = (await upload(admin.token, CSV)).json();
  assert.equal((await commit(admin.token, up.import.id)).json().error.code, 'IMPORT_NOT_VALIDATED');
  await validate(admin.token, up.import.id, { mapping: MAP, createCategories: true });
  const res = await Promise.all(Array.from({ length: 5 }, () => commit(admin.token, up.import.id)));
  assert.equal(res.filter((r) => r.statusCode === 200).length, 1);
  assert.ok(res.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 409));
  assert.equal(rows(await db.execute(sql`select count(*)::int n from items`))[0].n, 3);
});

test('LARGE imports go through the queue: 202 immediately, worker finishes it; a queue outage reverts to ready with a 503', async () => {
  const big = ['Name,Type,SKU,Qty', ...Array.from({ length: 520 }, (_, i) => `Bulk ${i},consumable,BULK-${i},${i + 1}`)].join('\n');
  const up = (await upload(admin.token, big)).json();
  await validate(admin.token, up.import.id, { mapping: { name: 'Name', type: 'Type', sku: 'SKU', quantity: 'Qty' } });

  setBreaker('queue', 'open');
  const down = await commit(admin.token, up.import.id);
  assert.equal(down.statusCode, 503);
  assert.equal(down.json().error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal((await call(app, admin.token, 'GET', `/imports/${up.import.id}`)).json().import.status, 'ready', 'a failed enqueue never strands the import in "committing"');
  setBreaker('queue', 'closed');

  const r = await commit(admin.token, up.import.id);
  assert.equal(r.statusCode, 202);
  assert.equal(r.json().import.status, 'committing');
  assert.ok((await getQueue('imports').getJobCounts('waiting', 'delayed', 'active')).waiting >= 1, 'a job is waiting for the worker');
  assert.equal((await call(app, admin.token, 'GET', '/items')).json().items.length, 0, 'nothing happens in the request');

  const result = await runCommit(db, await loadActor(db, admin.orgId, admin.userId), up.import.id); // what the worker does
  assert.deepEqual(result, { imported: 520, skipped: 0, failed: 0 });
  assert.equal((await call(app, admin.token, 'GET', `/imports/${up.import.id}`)).json().import.status, 'completed');
  assert.deepEqual(await findViolations(db), []);
  await getQueue('imports').obliterate({ force: true });
});

test('tenant isolation: another organization cannot see, validate, commit or download an import', async () => {
  const other = await registerOrg(app, 'Rival');
  const up = (await upload(admin.token, CSV)).json();
  assert.equal((await call(app, other.token, 'GET', `/imports/${up.import.id}`)).statusCode, 404);
  assert.equal((await validate(other.token, up.import.id, { mapping: MAP })).statusCode, 404);
  assert.equal((await commit(other.token, up.import.id)).statusCode, 404);
  assert.equal((await call(app, other.token, 'GET', `/imports/${up.import.id}/errors`)).statusCode, 404);
  assert.equal((await call(app, other.token, 'GET', '/imports')).json().items.length, 0);
});
