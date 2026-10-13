import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { users, sessions, emailOutbox } from '../src/db/schema.js';
import { setBreaker } from '../src/lib/resilience/circuit.js';
import { makeApp, resetAll, registerOrg, call, callIdem, createUser, flushMail, tokenFromMail, lastMailTo, PASSWORD, type App } from './helpers.js';

let app: App;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); });

const login = (slug: string, email: string, password = PASSWORD, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: slug, email, password, ...extra } });

test('register-org: creates org + admin and logs in; duplicate slug and weak passwords are refused', async () => {
  const a = await registerOrg(app, 'Acme Works');
  const me = await call(app, a.token, 'GET', '/auth/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, 'admin');
  assert.equal(me.json().organization.timezone, 'Africa/Lagos');

  const dup = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: 'X Co', slug: a.slug, email: 'z@z.test', password: PASSWORD } });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, 'SLUG_TAKEN');

  const weak = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: 'W Co', email: 'w@w.test', password: 'aaaaaaaaaaaaaaaa' } });
  assert.equal(weak.statusCode, 422);
  const short = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: 'W Co', email: 'w@w.test', password: 'short' } });
  assert.equal(short.statusCode, 400);
  const badTz = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: 'T Co', email: 't@t.test', password: PASSWORD, timezone: 'Mars/Olympus' } });
  assert.equal(badTz.statusCode, 422);

  // two orgs with the same auto-generated slug base both succeed (suffix allocated)
  const b = await registerOrg(app, 'Acme Works');
  assert.notEqual(b.slug, a.slug);
});

test('login: wrong password, unknown user and unknown org are indistinguishable (no enumeration)', async () => {
  const a = await registerOrg(app);
  const wrong = await login(a.slug, a.email, 'Wrong-Password-123');
  const unknownUser = await login(a.slug, 'nobody@acme.test');
  const unknownOrg = await login('no-such-org', a.email);
  for (const r of [wrong, unknownUser, unknownOrg]) assert.equal(r.statusCode, 401);
  assert.deepEqual(wrong.json().error.message, unknownUser.json().error.message);
  assert.deepEqual(wrong.json().error.message, unknownOrg.json().error.message);
});

test('login lockout: 5 bad attempts lock the account even against the correct password; response stays generic', async () => {
  const a = await registerOrg(app);
  for (let i = 0; i < 5; i++) assert.equal((await login(a.slug, a.email, 'Wrong-Password-123')).statusCode, 401);
  const afterLock = await login(a.slug, a.email); // correct password
  assert.equal(afterLock.statusCode, 401);
  assert.equal(afterLock.json().error.message, 'Invalid credentials');
  await db.update(users).set({ lockedUntil: sql`now() - interval '1 minute'` }).where(eq(users.id, a.userId));
  assert.equal((await login(a.slug, a.email)).statusCode, 200, 'lock expires');
});

test('concurrent wrong guesses cannot slip past the lock threshold (atomic counter)', async () => {
  const a = await registerOrg(app);
  await Promise.all(Array.from({ length: 12 }, () => login(a.slug, a.email, 'Wrong-Password-123')));
  const [u] = await db.select().from(users).where(eq(users.id, a.userId));
  assert.ok(u.failedLoginAttempts >= 5);
  assert.ok(u.lockedUntil && u.lockedUntil > new Date());
});

test('logout revokes the token immediately (cache invalidated, not merely expired)', async () => {
  const a = await registerOrg(app);
  assert.equal((await call(app, a.token, 'GET', '/auth/me')).statusCode, 200); // primes the Redis session cache
  assert.equal((await call(app, a.token, 'POST', '/auth/logout')).statusCode, 204);
  assert.equal((await call(app, a.token, 'GET', '/auth/me')).statusCode, 401);
});

test('invite flow: email via outbox, single-use token, login works, reuse and expiry rejected', async () => {
  const admin = await registerOrg(app);
  const inv = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'Sam@Acme.test', role: 'store_staff', name: 'Sam Storekeeper' });
  assert.equal(inv.statusCode, 201);
  assert.equal(inv.json().hasPassword, false);
  assert.equal(inv.json().email, 'sam@acme.test', 'emails are normalised');
  assert.equal(inv.json().inviteToken, undefined, 'the token is never returned over the API');

  // not deliverable until the worker runs — and a pending invitee cannot log in
  assert.equal(lastMailTo('sam@acme.test'), undefined);
  assert.equal((await login(admin.slug, 'sam@acme.test')).statusCode, 401);
  await flushMail();
  const token = tokenFromMail('sam@acme.test');

  const ok = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token, password: PASSWORD } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.role, 'store_staff');
  assert.equal((await login(admin.slug, 'sam@acme.test')).statusCode, 200);

  const reuse = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token, password: PASSWORD } });
  assert.equal(reuse.statusCode, 422);
  assert.equal(reuse.json().error.code, 'INVALID_TOKEN');

  // expiry
  await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'late@acme.test', role: 'viewer' });
  await flushMail();
  const lateToken = tokenFromMail('late@acme.test');
  await db.execute(sql`update auth_tokens set expires_at = now() - interval '1 second'`);
  const expired = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: lateToken, password: PASSWORD } });
  assert.equal(expired.statusCode, 422);
});

test('concurrent redemption of one invite token yields exactly one success', async () => {
  const admin = await registerOrg(app);
  await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'race@acme.test', role: 'viewer' });
  await flushMail();
  const token = tokenFromMail('race@acme.test');
  const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token, password: PASSWORD } })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(results.filter((r) => r.statusCode === 422).length, 5);
});

test('resending an invite invalidates the previous link; duplicate email is a 409', async () => {
  const admin = await registerOrg(app);
  const inv = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'dup@acme.test', role: 'viewer' });
  await flushMail();
  const first = tokenFromMail('dup@acme.test');
  assert.equal((await call(app, admin.token, 'POST', `/users/${inv.json().id}/invitations/resend`)).statusCode, 204);
  await flushMail();
  const second = tokenFromMail('dup@acme.test');
  assert.notEqual(first, second);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: first, password: PASSWORD } })).statusCode, 422);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: second, password: PASSWORD } })).statusCode, 200);
  const again = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'dup@acme.test', role: 'viewer' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, 'EMAIL_TAKEN');
  assert.equal((await call(app, admin.token, 'POST', `/users/${inv.json().id}/invitations/resend`)).statusCode, 409, 'already accepted');
});

test('RBAC: only admins manage users; viewers/staff get 403; unauthenticated gets 401', async () => {
  const admin = await registerOrg(app);
  const viewer = await createUser(app, admin, 'viewer');
  const staff = await createUser(app, admin, 'store_staff');
  assert.equal((await call(app, null, 'GET', '/users')).statusCode, 401);
  for (const s of [viewer, staff]) {
    assert.equal((await call(app, s.token, 'GET', '/users')).statusCode, 403);
    assert.equal((await callIdem(app, s.token, 'POST', '/users/invitations', { email: 'x@acme.test', role: 'admin' })).statusCode, 403);
    assert.equal((await call(app, s.token, 'PATCH', `/users/${admin.userId}`, { active: false })).statusCode, 403);
  }
  assert.equal((await call(app, admin.token, 'GET', '/users')).statusCode, 200);
});

test('mass assignment: unknown fields are rejected, never silently applied', async () => {
  const admin = await registerOrg(app);
  const staff = await createUser(app, admin, 'store_staff');
  const r1 = await call(app, admin.token, 'PATCH', `/users/${staff.userId}`, { role: 'viewer', orgId: crypto.randomUUID() });
  assert.equal(r1.statusCode, 400);
  const r2 = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'm@acme.test', role: 'viewer', passwordHash: 'x', active: true });
  assert.equal(r2.statusCode, 400);
  const r3 = await call(app, admin.token, 'PATCH', '/organization/settings', { staffCanManageItems: true, orgId: crypto.randomUUID() });
  assert.equal(r3.statusCode, 400);
});

test('invitations require an Idempotency-Key and replay the original response', async () => {
  const admin = await registerOrg(app);
  const noKey = await call(app, admin.token, 'POST', '/users/invitations', { email: 'k@acme.test', role: 'viewer' });
  assert.equal(noKey.statusCode, 400);
  const key = crypto.randomUUID();
  const a = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'k@acme.test', role: 'viewer' }, key);
  const b = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'k@acme.test', role: 'viewer' }, key);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(a.json().id, b.json().id);
  const diff = await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'other@acme.test', role: 'viewer' }, key);
  assert.equal(diff.statusCode, 409);
  assert.equal(diff.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('deactivating a user revokes their sessions at once; they cannot log in again; reactivation restores login', async () => {
  const admin = await registerOrg(app);
  const staff = await createUser(app, admin, 'store_staff');
  assert.equal((await call(app, staff.token, 'GET', '/auth/me')).statusCode, 200); // primes cache
  const off = await call(app, admin.token, 'PATCH', `/users/${staff.userId}`, { active: false });
  assert.equal(off.statusCode, 200);
  assert.equal((await call(app, staff.token, 'GET', '/auth/me')).statusCode, 401);
  assert.equal((await login(admin.slug, staff.email)).statusCode, 401);
  await call(app, admin.token, 'PATCH', `/users/${staff.userId}`, { active: true });
  assert.equal((await login(admin.slug, staff.email)).statusCode, 200);
});

test('role change takes effect on the very next request (cached session invalidated)', async () => {
  const admin = await registerOrg(app);
  const staff = await createUser(app, admin, 'supervisor');
  assert.equal((await call(app, staff.token, 'GET', '/users')).statusCode, 403);
  await call(app, admin.token, 'PATCH', `/users/${staff.userId}`, { role: 'admin' });
  assert.equal((await call(app, staff.token, 'GET', '/users')).statusCode, 200);
});

test('last-admin protection, including two admins demoting each other concurrently', async () => {
  const admin = await registerOrg(app);
  assert.equal((await call(app, admin.token, 'PATCH', `/users/${admin.userId}`, { role: 'viewer' })).json().error.code, 'LAST_ADMIN');
  assert.equal((await call(app, admin.token, 'PATCH', `/users/${admin.userId}`, { active: false })).json().error.code, 'CANNOT_DEACTIVATE_SELF');

  const second = await createUser(app, admin, 'admin');
  const results = await Promise.all([
    call(app, admin.token, 'PATCH', `/users/${second.userId}`, { role: 'viewer' }),
    call(app, second.token, 'PATCH', `/users/${admin.userId}`, { role: 'viewer' }),
  ]);
  const ok = results.filter((r) => r.statusCode === 200).length;
  assert.equal(ok, 1, 'exactly one demotion may win');
  const admins = await db.select().from(users).where(eq(users.role, 'admin'));
  assert.equal(admins.length, 1, 'the organization still has an administrator');
});

test('password reset: generic 202, email via outbox, revokes all sessions, single-use, unknown user sends nothing', async () => {
  const a = await registerOrg(app);
  const other = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: a.slug, email: 'ghost@acme.test' } });
  assert.equal(other.statusCode, 202);
  const known = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { orgSlug: a.slug, email: a.email } });
  assert.equal(known.statusCode, 202);
  assert.deepEqual(other.json(), known.json());
  await flushMail();
  assert.equal(lastMailTo('ghost@acme.test'), undefined);
  const token = tokenFromMail(a.email);

  const NEW = 'Brand-New-Passw0rd-42';
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token, password: NEW } })).statusCode, 204);
  assert.equal((await call(app, a.token, 'GET', '/auth/me')).statusCode, 401, 'old session is gone');
  assert.equal((await login(a.slug, a.email, PASSWORD)).statusCode, 401);
  assert.equal((await login(a.slug, a.email, NEW)).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token, password: NEW + 'x' } })).statusCode, 422);
});

test('PIN quick-switch for shared devices: trusted-device only, no admins, lockout, no chaining', async () => {
  const admin = await registerOrg(app);
  const staff = await createUser(app, admin, 'store_staff', 'Stella Storekeeper');

  // set PIN (needs the account password); weak PINs and admins are refused
  assert.equal((await call(app, staff.token, 'PUT', '/auth/pin', { password: PASSWORD, pin: '1234' })).statusCode, 422);
  assert.equal((await call(app, staff.token, 'PUT', '/auth/pin', { password: 'wrong-password-1', pin: '482913' })).statusCode, 401);
  assert.equal((await call(app, staff.token, 'PUT', '/auth/pin', { password: PASSWORD, pin: '482913' })).statusCode, 204);
  assert.equal((await call(app, admin.token, 'PUT', '/auth/pin', { password: PASSWORD, pin: '482913' })).statusCode, 403);

  // a normal (untrusted) session cannot mint PIN sessions and sees no roster
  assert.equal((await call(app, admin.token, 'POST', '/auth/pin-switch', { userId: staff.userId, pin: '482913' })).statusCode, 403);
  assert.deepEqual((await call(app, admin.token, 'GET', '/auth/pin-users')).json().items, []);

  // only supervisors/admins can register a shared device
  assert.equal((await login(admin.slug, staff.email, PASSWORD, { trustDevice: true })).statusCode, 403);
  const device = (await login(admin.slug, admin.email, PASSWORD, { trustDevice: true, deviceId: 'tablet-01' })).json();

  const roster = (await call(app, device.token, 'GET', '/auth/pin-users')).json().items;
  assert.deepEqual(roster.map((r: { name: string }) => r.name), ['Stella Storekeeper']);

  const sw = await call(app, device.token, 'POST', '/auth/pin-switch', { userId: staff.userId, pin: '482913' });
  assert.equal(sw.statusCode, 200);
  const me = await call(app, sw.json().token, 'GET', '/auth/me');
  assert.equal(me.json().sessionKind, 'pin');
  assert.equal(me.json().role, 'store_staff');
  assert.equal((await call(app, sw.json().token, 'POST', '/auth/pin-switch', { userId: staff.userId, pin: '482913' })).statusCode, 403, 'a PIN session cannot mint sessions');
  assert.equal((await call(app, sw.json().token, 'GET', '/users')).statusCode, 403);

  for (let i = 0; i < 5; i++) assert.equal((await call(app, device.token, 'POST', '/auth/pin-switch', { userId: staff.userId, pin: '999111' })).statusCode, 401);
  assert.equal((await call(app, device.token, 'POST', '/auth/pin-switch', { userId: staff.userId, pin: '482913' })).statusCode, 401, 'locked even with the right PIN');
});

test('tenant isolation: another organization cannot see or touch these users', async () => {
  const a = await registerOrg(app, 'Org A');
  const b = await registerOrg(app, 'Org B');
  const aStaff = await createUser(app, a, 'store_staff');
  assert.equal((await call(app, b.token, 'PATCH', `/users/${aStaff.userId}`, { active: false })).statusCode, 404);
  assert.equal((await call(app, b.token, 'POST', `/users/${aStaff.userId}/invitations/resend`)).statusCode, 404);
  assert.equal((await call(app, b.token, 'DELETE', `/users/${aStaff.userId}/pin`)).statusCode, 404);
  const list = (await call(app, b.token, 'GET', '/users')).json().items;
  assert.ok(list.every((u: { id: string }) => u.id !== aStaff.userId));
  const [still] = await db.select().from(users).where(eq(users.id, aStaff.userId));
  assert.equal(still.active, true);
});

test('organization settings & approval policy: admin-only writes, audited, validated', async () => {
  const admin = await registerOrg(app);
  const sup = await createUser(app, admin, 'supervisor');
  assert.equal((await call(app, sup.token, 'GET', '/organization/approval-policy')).statusCode, 200);
  assert.equal((await call(app, sup.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'direct', lossMode: 'direct', retirementMode: 'direct', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: null })).statusCode, 403);
  const put = await call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'all_approval', lossMode: 'staff_approval', retirementMode: 'staff_approval', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: 50 });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().largeAdjustmentThreshold, 50);
  assert.equal((await call(app, admin.token, 'PUT', '/organization/approval-policy', { adjustmentMode: 'whenever', lossMode: 'direct', retirementMode: 'direct', checkoutMode: 'direct', checkinMode: 'direct', largeAdjustmentThreshold: null })).statusCode, 400);
  const s = await call(app, admin.token, 'PATCH', '/organization/settings', { staffCanManageItems: true, requirePhotoFor: ['damage'] });
  assert.equal(s.json().staffCanManageItems, true);
  const audit = await db.execute(sql`select action from audit_events where org_id = ${admin.orgId} and action in ('policy.updated','settings.updated') order by created_at`);
  const rows = (Array.isArray(audit) ? audit : (audit as unknown as { rows: unknown[] }).rows) as Array<{ action: string }>;
  assert.deepEqual(rows.map((r) => r.action), ['policy.updated', 'settings.updated']);
});

test('locations: MVP allows one active store; default cannot be archived', async () => {
  const admin = await registerOrg(app);
  const list = (await call(app, admin.token, 'GET', '/locations')).json().items;
  assert.equal(list.length, 1);
  assert.equal(list[0].isDefault, true);
  const second = await call(app, admin.token, 'POST', '/locations', { name: 'Site B yard', kind: 'site' });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, 'LOCATION_LIMIT');
  assert.equal((await call(app, admin.token, 'POST', `/locations/${list[0].id}/archive`)).json().error.code, 'DEFAULT_LOCATION');
  assert.equal((await call(app, admin.token, 'PATCH', `/locations/${list[0].id}`, { name: 'Central Store' })).json().name, 'Central Store');
});

test('MAIL CIRCUIT BREAKER: an open Mailgun circuit defers mail without losing it or consuming attempts; recovery delivers it', async () => {
  const admin = await registerOrg(app);
  await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'cb@acme.test', role: 'viewer' });

  // Prime the breaker (it is created lazily on first send), then force it open as a Mailgun outage would.
  await flushMail();
  await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'cb2@acme.test', role: 'viewer' });
  setBreaker('mailgun', 'open');
  const result = await (await import('../src/modules/mail/outbox.js')).dispatchDueEmails(db);
  assert.equal(result.sent, 0);
  assert.equal(result.deferred, 1);
  const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.toEmail, 'cb2@acme.test'));
  assert.equal(row.status, 'pending', 'not lost, not failed');
  assert.equal(row.attempts, 0, 'an unhealthy provider does not burn the message\'s retry budget');

  // requests never block on mail: the API call that created the invite already succeeded above.
  setBreaker('mailgun', 'closed');
  await db.update(emailOutbox).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(emailOutbox.toEmail, 'cb2@acme.test'));
  const recovered = await (await import('../src/modules/mail/outbox.js')).dispatchDueEmails(db);
  assert.equal(recovered.sent, 1);
  assert.ok(lastMailTo('cb2@acme.test'));
});

test('sessions table never stores raw tokens', async () => {
  const a = await registerOrg(app);
  const rows = await db.select().from(sessions);
  assert.ok(rows.every((s) => s.tokenHash !== a.token && s.tokenHash.length === 64));
});
