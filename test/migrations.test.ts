/** Migration 0003 (governance) applied to a populated database at 0002, plus re-run idempotency. Uses a scratch database; never touches the test DB. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../scripts/migrate.js';

const base = new URL(process.env.DATABASE_URL!);
const name = `sk_migr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const admin = postgres(base.toString().replace(base.pathname, '/postgres'), { max: 1, onnotice: () => {} });
const scratch = () => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
const tmpRoot = mkdtempSync(join(tmpdir(), 'sk-mig-'));
after(async () => { await admin.unsafe(`drop database if exists ${name} with (force)`); await admin.end({ timeout: 5 }); rmSync(tmpRoot, { recursive: true, force: true }); });

test('0003 applies cleanly on top of a populated 0002 database; defaults, enum additions and new tables are right; re-running is a no-op', async () => {
  await admin.unsafe(`create database ${name}`);
  // A project root whose migrations stop at 0002.
  cpSync(join(process.cwd(), 'drizzle'), join(tmpRoot, 'drizzle'), { recursive: true });
  const jp = join(tmpRoot, 'drizzle/meta/_journal.json'); const j = JSON.parse(readFileSync(jp, 'utf8'));
  j.entries = j.entries.filter((e: { tag: string }) => !e.tag.startsWith('0003')); writeFileSync(jp, JSON.stringify(j));
  rmSync(join(tmpRoot, 'drizzle/0003_governance.sql'));
  await runMigrations(scratch(), tmpRoot);

  const db = postgres(scratch(), { max: 1, onnotice: () => {} });
  try {
    assert.equal((await db`select to_regclass('public.announcements') as t`)[0].t, null, 'precondition: still at 0002');
    // Representative pre-existing data.
    const [org] = await db`insert into organizations (name, slug, timezone) values ('Old Org', 'old-org', 'Africa/Lagos') returning id`;
    await db`insert into organization_settings (org_id) values (${org.id})`;
    const [u1] = await db`insert into users (org_id, email, password_hash, role) values (${org.id}, 'a@old.test', 'x', 'admin') returning id`;
    await db`insert into users (org_id, email, role) values (${org.id}, 'pending@old.test', 'viewer')`;
    const [cnt] = await db`select count(*)::int as n from users`; assert.equal(cnt.n, 2);
    const [ns] = await db`select count(*)::int as n from notifications`; assert.equal(ns.n, 0);

    await runMigrations(scratch()); // the real root: applies 0003

    const s = (await db`select near_minimum_percent, supervisors_can_invite from organization_settings where org_id = ${org.id}`)[0];
    assert.deepEqual([s.near_minimum_percent, s.supervisors_can_invite], [10, true], 'existing orgs get the documented defaults');
    const users = await db`select email, invited_by, invited_at from users order by email`;
    assert.equal(users.length, 2); assert.ok(users.every((u) => u.invited_by === null && u.invited_at === null), 'existing users untouched');
    const enumVals = (await db`select unnest(enum_range(null::notification_type))::text as v`).map((r) => r.v);
    for (const v of ['announcement', 'cycle_count_due', 'low_stock', 'overdue_checkout', 'approval_pending']) assert.ok(enumVals.includes(v), v);
    assert.deepEqual((await db`select unnest(enum_range(null::announcement_severity))::text as v`).map((r) => r.v), ['info', 'warning', 'critical']);
    for (const t of ['announcements', 'notification_rules']) assert.notEqual((await db`select to_regclass(${'public.' + t}) as t`)[0].t, null, t);

    // New tables are usable, FK-protected, and the new notification types insert.
    await db`insert into announcements (org_id, title, body, published_by) values (${org.id}, 't', 'b', ${u1.id})`;
    const a = (await db`select severity, audience_roles, send_email from announcements`)[0]; assert.deepEqual([a.severity, a.audience_roles, a.send_email], ['info', [], false]);
    await assert.rejects(() => db`insert into announcements (org_id, title, body, published_by) values (${org.id}, 't', 'b', gen_random_uuid())`, /foreign key/i);
    await db`insert into notifications (org_id, user_id, type, title, body, entity_type, entity_id, dedupe_key) values (${org.id}, ${u1.id}, 'cycle_count_due', 't', 'b', 'shelf', 'x', 'k1')`;

    // Idempotent: a second run changes nothing and does not error.
    const before = (await db`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n;
    await runMigrations(scratch()); await runMigrations(scratch());
    assert.equal((await db`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n, before);
    assert.equal((await db`select count(*)::int as n from users`)[0].n, 2);
    assert.equal(before, 4, 'four generated migrations are recorded');
  } finally { await db.end({ timeout: 5 }); }
});

test('the immutability triggers survive a full migration run (ledger and audit stay append-only)', async () => {
  const db = postgres(scratch(), { max: 1, onnotice: () => {} });
  try {
    const trg = (await db`select tgname from pg_trigger where not tgisinternal`).map((r) => r.tgname as string);
    assert.ok(trg.some((t) => /immutable/.test(t) && /transactions/.test(t)), trg.join(','));
    assert.ok(trg.some((t) => /audit/.test(t)), trg.join(','));
  } finally { await db.end({ timeout: 5 }); }
});
