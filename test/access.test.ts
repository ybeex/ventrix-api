/**
 * Exhaustive access-control audit. Unlike per-feature tests, this enumerates EVERY route the app registered and proves,
 * mechanically, that: (1) nothing is public except an explicit allowlist, (2) every other route rejects anonymous callers
 * with 401, (3) every route a role is not entitled to answers 403 — before validation, lookup or side effects.
 * Adding a route without declaring access makes the app refuse to boot; adding a public route fails THIS test.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registeredRoutes } from '../src/plugins/access.js';
import { PERMISSIONS, STAFF_GATED, type Permission } from '../src/lib/permissions.js';
import { makeApp, resetAll, registerOrg, createUser, type App, type Session } from './helpers.js';

let app: App;
let admin: Session, sup: Session, staff: Session, viewer: Session;
before(async () => {
  app = await makeApp(); await resetAll(app);
  admin = await registerOrg(app); sup = await createUser(app, admin, 'supervisor'); staff = await createUser(app, admin, 'store_staff'); viewer = await createUser(app, admin, 'viewer');
});
after(async () => { await app.close(); });

const PUBLIC_ALLOWLIST = new Set([
  'GET /healthz', 'GET /readyz', 'GET /metrics',
  'POST /v1/auth/register-org', 'POST /v1/auth/login', 'POST /v1/auth/accept-invite', 'POST /v1/auth/password-reset/request', 'POST /v1/auth/password-reset/confirm',
  'GET /v1/files/:id/content',
]);

const unique = () => {
  const seen = new Map<string, (typeof registeredRoutes)[number]>();
  for (const r of registeredRoutes) if (r.method !== 'HEAD' && r.method !== 'OPTIONS') seen.set(`${r.method} ${r.url}`, r);
  return [...seen.values()];
};
const fill = (url: string) => url.replace(/:id\b/g, crypto.randomUUID()).replace(/:type\b/g, 'low_stock').replace(/:name\b/g, 'inventory');
const hit = (method: string, url: string, token?: string) =>
  app.inject({ method: method as 'GET', url: fill(url), headers: token ? { authorization: `Bearer ${token}` } : {}, payload: ['POST', 'PUT', 'PATCH'].includes(method) ? ({} as never) : undefined });

test('the registry is complete and every declared permission exists', () => {
  const routes = unique();
  assert.ok(routes.length >= 100, `expected a large API surface, saw ${routes.length}`);
  for (const r of routes) assert.ok(r.permission === 'public' || r.permission in PERMISSIONS, `${r.method} ${r.url}`);
});

test('PUBLIC routes are exactly the allowlist — nothing is open by accident', () => {
  const pub = new Set(unique().filter((r) => r.permission === 'public').map((r) => `${r.method} ${r.url}`));
  assert.deepEqual([...pub].sort(), [...PUBLIC_ALLOWLIST].sort());
});

test('every protected route rejects anonymous and garbage-token callers with 401 (never 400/404/500)', async () => {
  const protectedRoutes = unique().filter((r) => r.permission !== 'public');
  for (const r of protectedRoutes) {
    const anon = await hit(r.method, r.url);
    assert.equal(anon.statusCode, 401, `anonymous ${r.method} ${r.url} -> ${anon.statusCode}`);
    const junk = await hit(r.method, r.url, 'x'.repeat(43));
    assert.equal(junk.statusCode, 401, `garbage token ${r.method} ${r.url} -> ${junk.statusCode}`);
  }
});

for (const [label, getTok, role] of [['viewer', () => viewer.token, 'viewer'], ['store_staff', () => staff.token, 'store_staff'], ['supervisor', () => sup.token, 'supervisor']] as const) {
  test(`${label}: every route outside the role's permissions answers 403 — before validation or any lookup`, async () => {
    let checked = 0;
    for (const r of unique().filter((x) => x.permission !== 'public')) {
      const perm = r.permission as Permission;
      const allowed = (PERMISSIONS[perm] as readonly string[]).includes(role) || (role === 'store_staff' && perm in STAFF_GATED); // staff-gated depends on org setting (off here → expect 403 too)
      const gatedOff = role === 'store_staff' && perm in STAFF_GATED && !(PERMISSIONS[perm] as readonly string[]).includes(role);
      if (allowed && !gatedOff) continue;
      const res = await hit(r.method, r.url, getTok());
      assert.equal(res.statusCode, 403, `${label} ${r.method} ${r.url} (${perm}) -> ${res.statusCode}`);
      checked++;
    }
    assert.ok(checked > 0);
  });
}

test('the admin role is entitled to everything (no route is accidentally unreachable)', () => {
  for (const r of unique().filter((x) => x.permission !== 'public')) assert.ok((PERMISSIONS[r.permission as Permission] as readonly string[]).includes('admin'), `${r.method} ${r.url}`);
});

test('PIN sessions inherit exactly the user role: a PIN session for a staff member is still denied admin routes', async () => {
  const dev = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { orgSlug: admin.slug, email: admin.email, password: 'Correct-Horse-9-Battery', trustDevice: true, deviceId: 'tablet-77' } });
  await app.inject({ method: 'PUT', url: '/v1/auth/pin', headers: { authorization: `Bearer ${staff.token}` }, payload: { password: 'Correct-Horse-9-Battery', pin: '482913' } });
  const sw = await app.inject({ method: 'POST', url: '/v1/auth/pin-switch', headers: { authorization: `Bearer ${dev.json().token}` }, payload: { userId: staff.userId, pin: '482913' } });
  assert.equal(sw.statusCode, 200);
  for (const [m, u] of [['GET', '/v1/users'], ['PUT', '/v1/organization/approval-policy'], ['GET', '/v1/reports'], ['GET', '/v1/activity'], ['POST', '/v1/reconciliations']] as const) {
    const r = await app.inject({ method: m, url: u, headers: { authorization: `Bearer ${sw.json().token}` }, payload: m === 'GET' ? undefined : ({} as never) });
    assert.equal(r.statusCode, 403, `${m} ${u}`);
  }
});
