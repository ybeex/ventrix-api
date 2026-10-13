/** Role-based invites: matrix, status derivation (raw SQL), revoke/resend/re-issue, bulk, supervisorsCanInvite, tenant isolation. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { makeApp, resetAll, registerOrg, createUser, call, callIdem, flushMail, lastMailTo, tokenFromMail, auditRows, PASSWORD, type App, type Session } from './helpers.js';

type Role = 'admin' | 'supervisor' | 'store_staff' | 'viewer';
const ROLES: Role[] = ['admin', 'supervisor', 'store_staff', 'viewer'];
let app: App; let admin: Session, sup: Session, staff: Session, viewer: Session, outsider: Session;
before(async () => {
  app = await makeApp(); await resetAll(app);
  admin = await registerOrg(app, 'Acme'); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff'); viewer = await createUser(app, admin, 'viewer');
  outsider = await registerOrg(app, 'Rival');
});
after(async () => { await app.close(); });

const tokOf = (r: Role) => ({ admin: admin.token, supervisor: sup.token, store_staff: staff.token, viewer: viewer.token })[r];
let n = 0; const mail = () => `invitee${++n}-${crypto.randomUUID().slice(0, 6)}@acme.test`;
const invite = (token: string, role: Role, email = mail(), name?: string) => callIdem(app, token, 'POST', '/users/invitations', { email, role, ...(name ? { name } : {}) });
const list = async (token: string, q = '') => (await call(app, token, 'GET', `/users/invitations${q}`)).json();
const expire = (userId: string) => db.execute(sql`update auth_tokens set expires_at = now() - interval '1 minute' where user_id = ${userId} and purpose = 'invite' and used_at is null`);

for (const actor of ROLES) for (const target of ROLES) {
  const allowed = actor === 'admin' || (actor === 'supervisor' && (target === 'store_staff' || target === 'viewer'));
  test(`matrix: ${actor} inviting ${target} → ${allowed ? '201' : '403'}`, async () => {
    const email = mail();
    const r = await invite(tokOf(actor), target, email);
    assert.equal(r.statusCode, allowed ? 201 : 403, r.body);
    if (allowed) { assert.equal(r.json().role, target); assert.equal(r.json().hasPassword, false); }
    else assert.equal((await call(app, admin.token, 'GET', '/users')).json().items.some((u: any) => u.email === email), false, 'a refused invite creates nothing');
  });
}

test('invite: audit row, e-mail with a working link, email normalised, name stored', async () => {
  const email = `MiXeD-${crypto.randomUUID().slice(0, 6)}@Acme.test`;
  const r = await invite(admin.token, 'store_staff', email, 'Mixed Case');
  assert.equal(r.statusCode, 201); assert.equal(r.json().email, email.toLowerCase()); assert.equal(r.json().name, 'Mixed Case');
  await flushMail();
  assert.ok(lastMailTo(email.toLowerCase())!.text.includes('/accept-invite?token='));
  const row = (await auditRows(admin.orgId, 'user.invited')).at(-1)!;
  assert.equal(row.entityId, r.json().id); assert.deepEqual(row.next, { email: email.toLowerCase(), role: 'store_staff', reissued: false });
});

test('duplicate invite: pending → 409 EMAIL_TAKEN (resend instead); existing user → 409; same email in ANOTHER org is fine', async () => {
  const email = mail();
  assert.equal((await invite(admin.token, 'viewer', email)).statusCode, 201);
  const dup = await invite(admin.token, 'viewer', email.toUpperCase());
  assert.equal(dup.statusCode, 409); assert.equal(dup.json().error.code, 'EMAIL_TAKEN'); assert.match(dup.json().error.message, /resend/i);
  assert.equal((await invite(admin.token, 'viewer', staff.email)).json().error.code, 'EMAIL_TAKEN');
  assert.equal((await invite(outsider.token, 'viewer', email)).statusCode, 201, 'tenants do not share an email namespace');
});

test('supervisorsCanInvite=false: invite, resend, revoke and bulk are refused for supervisors; admins unaffected; re-enabling restores', async () => {
  const pending = (await invite(admin.token, 'viewer')).json();
  assert.equal((await call(app, admin.token, 'PATCH', '/organization/settings', { supervisorsCanInvite: false })).statusCode, 200);
  try {
    const r = await invite(sup.token, 'viewer'); assert.equal(r.statusCode, 403); assert.match(r.json().error.message, /not permitted/);
    assert.equal((await call(app, sup.token, 'POST', `/users/${pending.id}/invitations/resend`)).statusCode, 403);
    assert.equal((await call(app, sup.token, 'POST', `/users/${pending.id}/invitations/revoke`)).statusCode, 403);
    const bulk = await callIdem(app, sup.token, 'POST', '/users/invitations/bulk', { invites: [{ email: mail(), role: 'viewer' }] });
    assert.equal(bulk.json().results[0].status, 'forbidden');
    assert.equal((await invite(admin.token, 'viewer')).statusCode, 201);
  } finally { await call(app, admin.token, 'PATCH', '/organization/settings', { supervisorsCanInvite: true }); }
  assert.equal((await invite(sup.token, 'viewer')).statusCode, 201);
});

test('status derivation: pending → (force-expire) expired → revoked, each visible through the list and the status filter', async () => {
  const u = (await invite(admin.token, 'store_staff')).json();
  const find = async (status?: string) => (await list(admin.token, status ? `?status=${status}&limit=100` : '?limit=100')).items.find((i: any) => i.id === u.id);
  assert.equal((await find())!.status, 'pending'); assert.ok((await find('pending')));
  assert.equal(await find('expired'), undefined);
  await expire(u.id);
  assert.equal((await find())!.status, 'expired'); assert.ok(await find('expired')); assert.equal(await find('pending'), undefined);
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/revoke`)).statusCode, 204);
  const rv = await find(); assert.equal(rv!.status, 'revoked'); assert.equal(rv!.expiresAt, null);
  assert.ok(await find('revoked'));
  const item = (await find('revoked'))!; assert.equal(item.invitedBy.id, admin.userId); assert.ok(item.invitedBy.name); assert.ok(item.invitedAt);
});

test('accepted invitations drop off the list', async () => {
  const email = mail(); const u = (await invite(admin.token, 'viewer', email)).json(); await flushMail();
  assert.ok((await list(admin.token, '?limit=100')).items.some((i: any) => i.id === u.id));
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: tokenFromMail(email), password: PASSWORD } });
  assert.equal(acc.statusCode, 200);
  assert.ok(!(await list(admin.token, '?limit=100')).items.some((i: any) => i.id === u.id));
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/resend`)).json().error.code, 'ALREADY_ACCEPTED');
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/revoke`)).json().error.code, 'ALREADY_ACCEPTED');
});

test('supervisor sees only staff/viewer invitations; staff and viewers see none (and cannot call the endpoint)', async () => {
  const a = (await invite(admin.token, 'admin')).json(); const s = (await invite(admin.token, 'supervisor')).json();
  const st = (await invite(admin.token, 'store_staff')).json(); const v = (await invite(admin.token, 'viewer')).json();
  const seen = (await list(sup.token, '?limit=100')).items.map((i: any) => i.id);
  assert.ok(seen.includes(st.id) && seen.includes(v.id)); assert.ok(!seen.includes(a.id) && !seen.includes(s.id));
  const adminSeen = (await list(admin.token, '?limit=100')).items.map((i: any) => i.id);
  for (const x of [a, s, st, v]) assert.ok(adminSeen.includes(x.id));
  assert.equal((await call(app, staff.token, 'GET', '/users/invitations')).statusCode, 403);
  assert.equal((await call(app, viewer.token, 'GET', '/users/invitations')).statusCode, 403);
});

test('supervisor cannot resend/revoke an admin or supervisor invitation (403) — and nothing changes', async () => {
  const a = (await invite(admin.token, 'admin')).json();
  const before = (await list(admin.token, '?limit=100')).items.find((i: any) => i.id === a.id);
  assert.equal((await call(app, sup.token, 'POST', `/users/${a.id}/invitations/revoke`)).statusCode, 403);
  assert.equal((await call(app, sup.token, 'POST', `/users/${a.id}/invitations/resend`)).statusCode, 403);
  assert.equal((await list(admin.token, '?limit=100')).items.find((i: any) => i.id === a.id).status, before.status);
});

test('revoke → login impossible, link dead; revoke is not repeatable; resend of a revoked invite is refused', async () => {
  const email = mail(); const u = (await invite(admin.token, 'viewer', email)).json(); await flushMail();
  const token = tokenFromMail(email);
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/revoke`)).statusCode, 204);
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token, password: PASSWORD } });
  assert.equal(acc.statusCode, 422); assert.equal(acc.json().error.code, 'INVALID_TOKEN');
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/revoke`)).json().error.code, 'INVITE_REVOKED');
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/resend`)).json().error.code, 'INVITE_REVOKED');
  const row = (await auditRows(admin.orgId, 'user.invite_revoked')).at(-1)!; assert.equal(row.entityId, u.id); assert.deepEqual(row.previous, { role: 'viewer' });
});

test('re-invite after revoke reuses the SAME user row, may change the role, issues a working link, and is audited as reissued', async () => {
  const email = mail(); const u1 = (await invite(admin.token, 'viewer', email, 'First Name')).json();
  await call(app, admin.token, 'POST', `/users/${u1.id}/invitations/revoke`);
  const u2 = await invite(admin.token, 'store_staff', email, 'Second Name');
  assert.equal(u2.statusCode, 201); assert.equal(u2.json().id, u1.id, 'same user row'); assert.equal(u2.json().role, 'store_staff'); assert.equal(u2.json().name, 'Second Name');
  assert.equal((await list(admin.token, '?limit=100')).items.find((i: any) => i.id === u1.id).status, 'pending');
  assert.deepEqual((await auditRows(admin.orgId, 'user.invited')).at(-1)!.next, { email, role: 'store_staff', reissued: true });
  await flushMail();
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: tokenFromMail(email), password: PASSWORD } });
  assert.equal(acc.statusCode, 200); assert.equal(acc.json().user.role, 'store_staff');
});

test('a supervisor re-inviting a revoked ADMIN invite as viewer is allowed only through the matrix for the NEW role (and the old role is overwritten)', async () => {
  const email = mail(); const u = (await invite(admin.token, 'admin', email)).json();
  await call(app, admin.token, 'POST', `/users/${u.id}/invitations/revoke`);
  const r = await invite(sup.token, 'viewer', email);
  assert.equal(r.statusCode, 201); assert.equal(r.json().role, 'viewer', 'role is replaced, never escalated');
});

test('resend replaces the previous link: old token dead, new token works, invitedAt refreshed, audit row', async () => {
  const email = mail(); const u = (await invite(admin.token, 'viewer', email)).json(); await flushMail();
  const oldTok = tokenFromMail(email);
  await db.execute(sql`update users set invited_at = now() - interval '3 days' where id = ${u.id}`);
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/resend`)).statusCode, 204); await flushMail();
  const newTok = tokenFromMail(email); assert.notEqual(oldTok, newTok);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: oldTok, password: PASSWORD } })).statusCode, 422);
  assert.equal((await auditRows(admin.orgId, 'user.invite_resent')).at(-1)!.entityId, u.id);
  const it = (await list(admin.token, '?limit=100')).items.find((i: any) => i.id === u.id);
  assert.ok(Date.now() - new Date(it.invitedAt).getTime() < 60_000, 'invitedAt refreshed');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: newTok, password: PASSWORD } })).statusCode, 200);
});

test('resend of an EXPIRED invite makes it pending again', async () => {
  const u = (await invite(admin.token, 'viewer')).json(); await expire(u.id);
  assert.equal((await list(admin.token, '?limit=100')).items.find((i: any) => i.id === u.id).status, 'expired');
  assert.equal((await call(app, admin.token, 'POST', `/users/${u.id}/invitations/resend`)).statusCode, 204);
  assert.equal((await list(admin.token, '?limit=100')).items.find((i: any) => i.id === u.id).status, 'pending');
});

test('bulk: partial success with invited / exists / forbidden / invalid, duplicates inside the request, each outcome independent', async () => {
  const fresh = mail(); const fresh2 = mail();
  const body = { invites: [
    { email: fresh, role: 'viewer' }, { email: staff.email, role: 'viewer' }, { email: mail(), role: 'admin' },
    { email: fresh.toUpperCase(), role: 'store_staff' }, { email: fresh2, role: 'store_staff', name: 'Bulk Two' },
  ] };
  const r = await callIdem(app, sup.token, 'POST', '/users/invitations/bulk', body);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().results.map((x: any) => x.status), ['invited', 'exists', 'forbidden', 'invalid', 'invited']);
  assert.ok(r.json().results[0].userId); assert.match(r.json().results[3].message, /more than once/);
  const users = (await call(app, admin.token, 'GET', '/users?limit=100')).json().items;
  assert.equal(users.find((u: any) => u.email === fresh).role, 'viewer', 'the first listing wins; the duplicate did not overwrite it');
  assert.equal(users.find((u: any) => u.email === fresh2).name, 'Bulk Two');
  assert.equal((await callIdem(app, sup.token, 'POST', '/users/invitations/bulk', { invites: [] })).statusCode, 400);
});

test('bulk replay with the same Idempotency-Key does not invite twice', async () => {
  const key = crypto.randomUUID(); const email = mail();
  const a = await callIdem(app, admin.token, 'POST', '/users/invitations/bulk', { invites: [{ email, role: 'viewer' }] }, key);
  const b = await callIdem(app, admin.token, 'POST', '/users/invitations/bulk', { invites: [{ email, role: 'viewer' }] }, key);
  assert.equal(a.json().results[0].status, 'invited'); assert.deepEqual(a.json(), b.json());
});

test('list pagination: cursor walks every invitation exactly once, newest first, even with identical created_at', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await invite(admin.token, 'viewer')).json().id);
  await db.execute(sql`update users set created_at = '2030-01-01T00:00:00.000Z' where id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
  const seen: string[] = []; let cursor: string | null = null;
  do { const p: any = await list(admin.token, `?limit=2&status=pending${cursor ? `&cursor=${cursor}` : ''}`); seen.push(...p.items.map((i: any) => i.id)); cursor = p.nextCursor; } while (cursor);
  for (const id of ids) assert.equal(seen.filter((s) => s === id).length, 1, 'each exactly once');
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(seen.slice(0, 5), [...ids].sort().reverse(), 'ties break by id desc');
});

test('cross-tenant: other orgs’ invitations are invisible and untouchable (404)', async () => {
  const mine = (await invite(admin.token, 'viewer')).json();
  assert.ok(!(await list(outsider.token, '?limit=100')).items.some((i: any) => i.id === mine.id));
  assert.equal((await call(app, outsider.token, 'POST', `/users/${mine.id}/invitations/resend`)).statusCode, 404);
  assert.equal((await call(app, outsider.token, 'POST', `/users/${mine.id}/invitations/revoke`)).statusCode, 404);
  assert.equal((await list(admin.token, '?limit=100')).items.find((i: any) => i.id === mine.id).status, 'pending');
});

test('validation: bad role / bad email / unknown field are 400; unknown id is 404', async () => {
  assert.equal((await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'nope', role: 'viewer' })).statusCode, 400);
  assert.equal((await callIdem(app, admin.token, 'POST', '/users/invitations', { email: mail(), role: 'owner' })).statusCode, 400);
  assert.equal((await callIdem(app, admin.token, 'POST', '/users/invitations', { email: mail(), role: 'viewer', active: true })).statusCode, 400);
  assert.equal((await call(app, admin.token, 'POST', `/users/${crypto.randomUUID()}/invitations/resend`)).statusCode, 404);
  assert.equal((await call(app, admin.token, 'GET', '/users/invitations?status=bogus')).statusCode, 400);
});
