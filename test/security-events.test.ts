/**
 * Security-event logging (WS1 §2). The invariant under test: logging failures NEVER changes what the caller sees —
 * same generic 401, same 202, same 403 — while admins get forensic rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { makeApp, resetAll, registerOrg, createUser, call, auditRows, auditCount, PASSWORD, type App, type Session } from './helpers.js';

let app: App; let admin: Session, staff: Session, sup: Session;
before(async () => {
  app = await makeApp(); await resetAll(app);
  admin = await registerOrg(app); staff = await createUser(app, admin, 'store_staff'); sup = await createUser(app, admin, 'supervisor');
});
after(async () => { await app.close(); });

const login = (slug: string, email: string, password: string, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: slug, email, password, ...extra } });

test('bad password: generic 401 + one auth.login_failed row (reason bad_password) attributed to the user', async () => {
  const before = await auditCount(admin.orgId, 'auth.login_failed');
  const r = await login(admin.slug, staff.email, 'wrong-password-xyz');
  assert.equal(r.statusCode, 401);
  const rows = await auditRows(admin.orgId, 'auth.login_failed');
  assert.equal(rows.length, before + 1);
  const row = rows.at(-1)!;
  assert.equal(row.entityType, 'user'); assert.equal(row.entityId, staff.userId); assert.equal((row.next as any).reason, 'bad_password'); assert.equal(row.actorUserId, null);
  assert.ok(!JSON.stringify(row).includes('wrong-password-xyz'), 'the attempted password is never stored');
});

test('response bodies are identical for bad password, unknown user and unknown org (no enumeration)', async () => {
  const a = await login(admin.slug, staff.email, 'nope-nope-nope-1');
  const b = await login(admin.slug, 'ghost@acme.test', 'nope-nope-nope-1');
  const c = await login('no-such-org', 'ghost@acme.test', 'nope-nope-nope-1');
  for (const r of [a, b, c]) assert.equal(r.statusCode, 401);
  const strip = (r: typeof a) => { const j = r.json(); delete j.error?.requestId; delete j.requestId; return JSON.stringify(j); };
  assert.equal(strip(a), strip(b)); assert.equal(strip(b), strip(c));
});

test('unknown user in a real org logs against the organization (reason unknown_user); unknown org logs nothing', async () => {
  const before = await auditRows(admin.orgId, 'auth.login_failed');
  await login(admin.slug, 'ghost2@acme.test', 'nope-nope-nope-1');
  const after = await auditRows(admin.orgId, 'auth.login_failed');
  assert.equal(after.length, before.length + 1);
  const row = after.at(-1)!; assert.equal(row.entityType, 'organization'); assert.equal(row.entityId, admin.orgId); assert.equal((row.next as any).reason, 'unknown_user');
  const total = await db.execute(sql`select count(*)::int as n from audit_events`);
  const n = (Array.isArray(total) ? total : (total as any).rows)[0].n;
  await login('no-such-org', 'ghost@acme.test', 'nope-nope-nope-1');
  const total2 = await db.execute(sql`select count(*)::int as n from audit_events`);
  assert.equal((Array.isArray(total2) ? total2 : (total2 as any).rows)[0].n, n, 'nowhere to attribute it → nothing written');
});

test('inactive account: still the generic 401, reason inactive, and the failure counter is not incremented', async () => {
  const victim = await createUser(app, admin, 'viewer');
  assert.equal((await call(app, admin.token, 'PATCH', `/users/${victim.userId}`, { active: false })).statusCode, 200);
  const r = await login(admin.slug, victim.email, PASSWORD);
  assert.equal(r.statusCode, 401);
  const row = (await auditRows(admin.orgId, 'auth.login_failed')).at(-1)!;
  assert.equal(row.entityId, victim.userId); assert.equal((row.next as any).reason, 'inactive');
  const n = await db.execute(sql`select failed_login_attempts as n from users where id = ${victim.userId}`);
  assert.equal((Array.isArray(n) ? n : (n as any).rows)[0].n, 0);
});

test('lockout: auth.account_locked fires exactly once, on the 5th failure; later attempts log reason "locked"', async () => {
  const target = await createUser(app, admin, 'store_staff');
  const failedBefore = await auditCount(admin.orgId, 'auth.login_failed');
  const lockedBefore = await auditCount(admin.orgId, 'auth.account_locked');
  for (let i = 1; i <= 7; i++) {
    const r = await login(admin.slug, target.email, `wrong-${i}-wrong-${i}`);
    assert.equal(r.statusCode, 401, `attempt ${i}`);
    const locks = (await auditCount(admin.orgId, 'auth.account_locked')) - lockedBefore;
    assert.equal(locks, i >= 5 ? 1 : 0, `after attempt ${i}`);
  }
  assert.equal((await auditCount(admin.orgId, 'auth.login_failed')) - failedBefore, 7);
  const rows = (await auditRows(admin.orgId, 'auth.login_failed')).slice(-7).map((x) => (x.next as any).reason);
  assert.deepEqual(rows, ['bad_password', 'bad_password', 'bad_password', 'bad_password', 'bad_password', 'locked', 'locked']);
  const lock = (await auditRows(admin.orgId, 'auth.account_locked')).at(-1)!;
  assert.equal(lock.entityId, target.userId); assert.equal((lock.next as any).after, 5);
  // the correct password is refused while locked — and the response is still the generic 401
  assert.equal((await login(admin.slug, target.email, PASSWORD)).statusCode, 401);
});

test('concurrent wrong guesses cannot produce two lock events', async () => {
  const target = await createUser(app, admin, 'store_staff');
  const lockedBefore = await auditCount(admin.orgId, 'auth.account_locked');
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => login(admin.slug, target.email, `bad-${i}-bad-${i}-x`)));
  assert.ok(rs.every((r) => r.statusCode === 401));
  assert.equal((await auditCount(admin.orgId, 'auth.account_locked')) - lockedBefore, 1);
});

test('successful login resets the counter and logs auth.login', async () => {
  const u = await createUser(app, admin, 'viewer');
  for (let i = 0; i < 3; i++) await login(admin.slug, u.email, `bad-${i}-pass-${i}-x`);
  const before = await auditCount(admin.orgId, 'auth.login');
  assert.equal((await login(admin.slug, u.email, PASSWORD)).statusCode, 200);
  assert.equal(await auditCount(admin.orgId, 'auth.login'), before + 1);
  for (let i = 0; i < 4; i++) await login(admin.slug, u.email, `bad2-${i}-pass-${i}-x`);
  assert.equal((await login(admin.slug, u.email, PASSWORD)).statusCode, 200, '3 + reset + 4 failures is below the threshold');
});

test('logout and logout-all are logged with the session / session count', async () => {
  const s1 = await login(admin.slug, sup.email, PASSWORD); const s2 = await login(admin.slug, sup.email, PASSWORD);
  const t1 = s1.json().token as string, t2 = s2.json().token as string;
  const lo = await call(app, t1, 'POST', '/auth/logout');
  assert.equal(lo.statusCode, 204);
  const row = (await auditRows(admin.orgId, 'auth.logout')).at(-1)!;
  assert.equal(row.actorUserId, sup.userId); assert.ok((row.next as any).sessionId);
  assert.equal((await call(app, t1, 'GET', '/auth/me')).statusCode, 401, 'logged-out token is dead immediately');
  const all = await call(app, t2, 'POST', '/auth/logout-all');
  assert.equal(all.statusCode, 204);
  const r2 = (await auditRows(admin.orgId, 'auth.logout_all')).at(-1)!;
  assert.ok((r2.next as any).sessions >= 2, 'counts every session removed (incl. the ones from createUser)');
  assert.equal((await call(app, t2, 'GET', '/auth/me')).statusCode, 401);
});

test('failed PIN: 401 "Invalid PIN", one auth.pin_failed row; a correct PIN logs auth.pin_switch', async () => {
  const dev = await login(admin.slug, admin.email, PASSWORD, { trustDevice: true, deviceId: 'tablet-9' });
  assert.equal(dev.statusCode, 200);
  const u = await createUser(app, admin, 'store_staff');
  assert.equal((await call(app, u.token, 'PUT', '/auth/pin', { password: PASSWORD, pin: '482913' })).statusCode, 204);
  const before = await auditCount(admin.orgId, 'auth.pin_failed');
  const bad = await call(app, dev.json().token, 'POST', '/auth/pin-switch', { userId: u.userId, pin: '111111' });
  assert.equal(bad.statusCode, 401);
  const rows = await auditRows(admin.orgId, 'auth.pin_failed');
  assert.equal(rows.length, before + 1); assert.equal(rows.at(-1)!.entityId, u.userId); assert.equal((rows.at(-1)!.next as any).deviceId, 'tablet-9');
  assert.ok(!JSON.stringify(rows.at(-1)).includes('111111'));
  const sw = await call(app, dev.json().token, 'POST', '/auth/pin-switch', { userId: u.userId, pin: '482913' });
  assert.equal(sw.statusCode, 200);
  assert.equal((await auditRows(admin.orgId, 'auth.pin_switch')).at(-1)!.entityId, u.userId);
});

test('password reset request: identical 202 for known and unknown users; a row for both; no token material in the log', async () => {
  const before = await auditRows(admin.orgId, 'auth.password_reset_requested');
  const known = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: admin.slug, email: staff.email } });
  const unknown = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: admin.slug, email: 'nobody@acme.test' } });
  assert.equal(known.statusCode, 202); assert.equal(unknown.statusCode, 202); assert.deepEqual(known.json(), unknown.json());
  const rows = (await auditRows(admin.orgId, 'auth.password_reset_requested')).slice(before.length);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => (r.next as any).known), [true, false]);
  assert.equal(rows[0].entityType, 'user'); assert.equal(rows[1].entityType, 'organization');
  assert.ok(!/token/i.test(JSON.stringify(rows)));
});

test('access.denied: records route + permission + role, never the request body, and the caller still gets a plain 403', async () => {
  const before = await auditCount(admin.orgId, 'access.denied');
  const r = await call(app, staff.token, 'POST', '/shelves', { name: 'SECRET-BODY-MARKER' });
  assert.equal(r.statusCode, 403);
  const rows = await auditRows(admin.orgId, 'access.denied');
  assert.equal(rows.length, before + 1);
  const row = rows.at(-1)!;
  assert.equal(row.actorUserId, staff.userId); assert.equal(row.entityType, 'route'); assert.equal(row.entityId, 'POST /v1/shelves');
  assert.deepEqual(row.next, { permission: 'shelves:manage', role: 'store_staff' });
  assert.ok(!JSON.stringify(row).includes('SECRET-BODY-MARKER'));
  assert.equal(r.json().error.code, 'FORBIDDEN');
});

test('access.denied is not written for allowed requests or for 401s (no identity to attribute)', async () => {
  const before = await auditCount(admin.orgId, 'access.denied');
  await call(app, admin.token, 'GET', '/shelves'); await call(app, null, 'GET', '/shelves'); await call(app, 'x'.repeat(43), 'GET', '/shelves');
  assert.equal(await auditCount(admin.orgId, 'access.denied'), before);
});

test('an audit-write failure never turns a 401/403 into a 500, nor changes the response', async () => {
  await db.execute(sql`alter table audit_events add constraint tmp_block_all check (false) not valid`);
  try {
    const bad = await login(admin.slug, staff.email, 'wrong-wrong-wrong-1');
    assert.equal(bad.statusCode, 401); assert.equal(bad.json().error.code, 'UNAUTHORIZED');
    const denied = await call(app, staff.token, 'POST', '/shelves', { name: 'x' });
    assert.equal(denied.statusCode, 403);
    const reset = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: admin.slug, email: staff.email } });
    assert.equal(reset.statusCode, 202);
  } finally { await db.execute(sql`alter table audit_events drop constraint tmp_block_all`); }
});
