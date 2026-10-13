/** Session management: list/revoke own, admin list/revoke-all, isolation, and that revocation bites immediately (cache invalidated). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, resetAll, registerOrg, createUser, call, auditRows, PASSWORD, type App, type Session } from './helpers.js';

let app: App; let admin: Session, staff: Session, other: Session, outsider: Session;
before(async () => {
  app = await makeApp(); await resetAll(app);
  admin = await registerOrg(app, 'Acme'); staff = await createUser(app, admin, 'store_staff'); other = await createUser(app, admin, 'supervisor');
  outsider = await registerOrg(app, 'Rival Co');
});
after(async () => { await app.close(); });

const loginAs = async (s: Session, extra: object = {}) =>
  (await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'user-agent': 'TestAgent/1.0' }, payload: { orgSlug: s.slug, email: s.email, password: PASSWORD, ...extra } })).json().token as string;
const mine = async (token: string) => (await call(app, token, 'GET', '/auth/sessions')).json().items as any[];

test('list: shows only my sessions, flags exactly one as current, exposes device metadata but never token material', async () => {
  const t2 = await loginAs(staff, { deviceId: 'phone-1' });
  const items = await mine(t2);
  assert.ok(items.length >= 2);
  assert.equal(items.filter((i) => i.current).length, 1);
  const cur = items.find((i) => i.current)!; assert.equal(cur.deviceId, 'phone-1'); assert.equal(cur.userAgent, 'TestAgent/1.0');
  assert.ok(!JSON.stringify(items).match(/token/i));
  // another user's sessions never appear in mine
  const theirs = await mine(other.token); assert.ok(theirs.every((i) => !items.some((j) => j.id === i.id)));
});

test('revoke own (other device): that token is 401 immediately, the calling token keeps working, a session.revoked row is written', async () => {
  const a = await loginAs(staff, { deviceId: 'dev-a' }); const b = await loginAs(staff, { deviceId: 'dev-b' });
  assert.equal((await call(app, a, 'GET', '/auth/me')).statusCode, 200); // warms the session cache
  const target = (await mine(b)).find((i) => i.deviceId === 'dev-a')!;
  const r = await call(app, b, 'DELETE', `/auth/sessions/${target.id}`);
  assert.equal(r.statusCode, 204);
  assert.equal((await call(app, a, 'GET', '/auth/me')).statusCode, 401, 'revocation is immediate even though the session was cached');
  assert.equal((await call(app, b, 'GET', '/auth/me')).statusCode, 200);
  const row = (await auditRows(admin.orgId, 'session.revoked')).at(-1)!;
  assert.equal(row.actorUserId, staff.userId); assert.equal((row.next as any).sessionId, target.id); assert.equal((row.next as any).own, true);
  assert.equal((await call(app, b, 'DELETE', `/auth/sessions/${target.id}`)).statusCode, 404, 'already gone');
});

test('a user can revoke their CURRENT session too (equivalent to logout)', async () => {
  const t = await loginAs(staff);
  const cur = (await mine(t)).find((i) => i.current)!;
  assert.equal((await call(app, t, 'DELETE', `/auth/sessions/${cur.id}`)).statusCode, 204);
  assert.equal((await call(app, t, 'GET', '/auth/me')).statusCode, 401);
});

test('cannot revoke another user’s session id (404, and their session survives)', async () => {
  const victimTok = await loginAs(other);
  const victimSession = (await mine(victimTok)).find((i) => i.current)!;
  const r = await call(app, staff.token, 'DELETE', `/auth/sessions/${victimSession.id}`);
  assert.equal(r.statusCode, 404);
  assert.equal((await call(app, victimTok, 'GET', '/auth/me')).statusCode, 200);
});

test('cross-tenant: an admin of another org can neither list, revoke nor see this org’s sessions', async () => {
  const victim = (await mine(staff.token)).find((i) => i.current)!;
  assert.equal((await call(app, outsider.token, 'DELETE', `/auth/sessions/${victim.id}`)).statusCode, 404);
  assert.equal((await call(app, outsider.token, 'GET', `/users/${staff.userId}/sessions`)).statusCode, 404);
  assert.equal((await call(app, outsider.token, 'DELETE', `/users/${staff.userId}/sessions`)).statusCode, 404);
  assert.equal((await call(app, staff.token, 'GET', '/auth/me')).statusCode, 200);
});

test('admin list: sees a user’s sessions in the org; non-admins are refused', async () => {
  const r = await call(app, admin.token, 'GET', `/users/${staff.userId}/sessions`);
  assert.equal(r.statusCode, 200); assert.ok(r.json().items.length >= 1);
  assert.ok(r.json().items.every((i: any) => i.current === false), '"current" only makes sense for your own list');
  assert.equal((await call(app, other.token, 'GET', `/users/${staff.userId}/sessions`)).statusCode, 403);
  assert.equal((await call(app, staff.token, 'DELETE', `/users/${staff.userId}/sessions`)).statusCode, 403);
});

test('admin revoke-all: every device of the target is signed out at once; count + audit row; others untouched', async () => {
  const victim = await createUser(app, admin, 'store_staff');
  const t1 = await loginAs(victim); const t2 = await loginAs(victim);
  for (const t of [victim.token, t1, t2]) assert.equal((await call(app, t, 'GET', '/auth/me')).statusCode, 200);
  const r = await call(app, admin.token, 'DELETE', `/users/${victim.userId}/sessions`);
  assert.equal(r.statusCode, 200); assert.equal(r.json().revoked, 3);
  for (const t of [victim.token, t1, t2]) assert.equal((await call(app, t, 'GET', '/auth/me')).statusCode, 401);
  assert.equal((await call(app, staff.token, 'GET', '/auth/me')).statusCode, 200);
  const row = (await auditRows(admin.orgId, 'session.revoked')).at(-1)!;
  assert.equal(row.actorUserId, admin.userId); assert.equal(row.entityId, victim.userId); assert.deepEqual({ n: (row.next as any).sessions, all: (row.next as any).allDevices }, { n: 3, all: true });
  assert.equal((await call(app, admin.token, 'DELETE', `/users/${victim.userId}/sessions`)).json().revoked, 0, 'idempotent');
});

test('a deactivated user has no usable sessions, and their list is empty after revoke-all', async () => {
  const u = await createUser(app, admin, 'viewer');
  assert.equal((await call(app, admin.token, 'PATCH', `/users/${u.userId}`, { active: false })).statusCode, 200);
  assert.equal((await call(app, u.token, 'GET', '/auth/me')).statusCode, 401);
  await call(app, admin.token, 'DELETE', `/users/${u.userId}/sessions`);
  assert.deepEqual((await call(app, admin.token, 'GET', `/users/${u.userId}/sessions`)).json().items, []);
});

test('expired sessions are not listed', async () => {
  const { db } = await import('../src/db/index.js'); const { sql } = await import('drizzle-orm');
  const t = await loginAs(other);
  const cur = (await mine(t)).find((i) => i.current)!;
  const before = (await mine(other.token)).length;
  await db.execute(sql`update sessions set expires_at = now() - interval '1 minute' where id = ${cur.id}`);
  const after = (await mine(other.token)).map((i) => i.id);
  assert.ok(!after.includes(cur.id)); assert.ok(after.length <= before);
});

test('unknown / malformed session ids: 404 and 400', async () => {
  assert.equal((await call(app, staff.token, 'DELETE', `/auth/sessions/${crypto.randomUUID()}`)).statusCode, 404);
  assert.equal((await call(app, staff.token, 'DELETE', '/auth/sessions/not-a-uuid')).statusCode, 400);
});
