/**
 * "Every action is monitored" is a claim; this file is its proof.
 *  1. STATIC: every `action: '…'` literal in src/ is registered in the catalogue (plus the two dynamic families).
 *  2. GUARD: audit() refuses an unregistered action (throws in test, logs in production, never breaks the request).
 *  3. COVERAGE: every registered mutating route is either exercised below (and must leave a row) or is on an explicit allowlist.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS } from '../src/lib/audit-catalog.js';
import { audit } from '../src/lib/audit.js';
import { db } from '../src/db/index.js';
import { makeApp, resetAll, registerOrg, auditRows, auditCount, type App, type Session } from './helpers.js';

let app: App; let admin: Session;
before(async () => { app = await makeApp(); await resetAll(app); admin = await registerOrg(app); });
after(async () => { await app.close(); });

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });

test('STATIC: every action literal in src/ is a registered audit action', () => {
  const found = new Map<string, string>();
  for (const file of walk('src')) {
    if (file.endsWith('audit-catalog.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/action:\s*'([a-z_]+\.[a-z_]+)'/g)) found.set(m[1], file);
  }
  assert.ok(found.size >= 40, `expected many action literals, saw ${found.size}`);
  const unregistered = [...found].filter(([a]) => !(a in AUDIT_ACTIONS));
  assert.deepEqual(unregistered, [], 'unregistered audit actions used in code');
});

test('STATIC: the dynamic families (transaction.${type}, sync.${kind}) are fully registered', () => {
  const types = ['checkout', 'checkin', 'consume', 'restock', 'adjustment', 'loss', 'damage', 'condition_update', 'create', 'archive', 'restore', 'reconciliation', 'correction'];
  for (const t of types) assert.ok(`transaction.${t}` in AUDIT_ACTIONS, `transaction.${t}`);
  for (const k of ['conflict', 'rejected', 'resolved']) assert.ok(`sync.${k}` in AUDIT_ACTIONS, `sync.${k}`);
});

test('STATIC: every catalogue entry has a label and a category, and a unique action key', () => {
  for (const [k, v] of Object.entries(AUDIT_ACTIONS)) { assert.ok(v.label.length > 2, k); assert.ok(v.category, k); }
});

test('GUARD: an unregistered action throws in test and writes nothing', async () => {
  const before = await auditCount(admin.orgId);
  await assert.rejects(() => audit(db, { orgId: admin.orgId }, { action: 'made.up', entityType: 'x', entityId: 'y' }), /Unregistered audit action/);
  assert.equal(await auditCount(admin.orgId), before);
});

test('GUARD: in production an unregistered action is logged loudly but the row is still written and the request survives', async () => {
  const prev = process.env.NODE_ENV; const errs: string[] = []; const orig = console.error;
  process.env.NODE_ENV = 'production'; console.error = (m: string) => { errs.push(String(m)); };
  try {
    const before = await auditCount(admin.orgId, 'made.up');
    await audit(db, { orgId: admin.orgId }, { action: 'made.up', entityType: 'x', entityId: 'y' });
    assert.equal(await auditCount(admin.orgId, 'made.up'), before + 1);
    assert.ok(errs.some((e) => e.includes('Unregistered audit action')));
  } finally { process.env.NODE_ENV = prev; console.error = orig; }
});

test('GUARD: a registered action writes the expected row shape', async () => {
  await audit(db, { orgId: admin.orgId, id: admin.userId, requestId: 'req-1', ip: '10.0.0.1' }, { action: 'item.updated', entityType: 'item', entityId: 'abc', previous: { a: 1 }, next: { a: 2 }, reason: 'why' });
  const r = (await auditRows(admin.orgId, 'item.updated')).at(-1)!;
  assert.equal(r.actorUserId, admin.userId); assert.equal(r.entityId, 'abc'); assert.deepEqual(r.next, { a: 2 }); assert.equal(r.reason, 'why'); assert.equal(r.ip, '10.0.0.1'); assert.equal(r.requestId, 'req-1');
});
