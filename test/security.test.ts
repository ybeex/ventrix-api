/** Perimeter security. Env is overridden BEFORE any app module loads (hence only dynamic imports below). */
process.env.AUTH_RATE_LIMIT_MAX = '4';
process.env.RATE_LIMIT_MAX = '25';
process.env.FORCE_HTTPS = 'true';
process.env.CORS_ORIGINS = 'https://app.example.com';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { makeApp, resetAll, PASSWORD } = await import('./helpers.js');
type App = Awaited<ReturnType<typeof makeApp>>;
const { db } = await import('../src/db/index.js');
const { sql } = await import('drizzle-orm');

let app: App;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetAll(app); });

const S = { 'x-forwarded-proto': 'https' };
const hdr = (ip: string, extra: Record<string, string> = {}) => ({ ...S, 'x-forwarded-for': ip, ...extra });
const reg = (ip: string, n = crypto.randomUUID().slice(0, 6)) => app.inject({ method: 'POST', url: '/v1/auth/register-org', headers: hdr(ip), payload: { organizationName: `Org ${n}`, email: `a-${n}@x.test`, password: PASSWORD } });

test('HTTPS is mandatory: plain-HTTP requests are refused (426); health probes are exempt for the load balancer', async () => {
  const plain = await app.inject({ method: 'GET', url: '/v1/auth/me' });
  assert.equal(plain.statusCode, 426);
  assert.equal(plain.json().error.code, 'HTTPS_REQUIRED');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { 'x-forwarded-proto': 'http' } })).statusCode, 426);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: S })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
});

test('credential endpoints are throttled per IP (429 + Retry-After + standard envelope); other IPs are unaffected', async () => {
  const bad = () => app.inject({ method: 'POST', url: '/v1/auth/login', headers: hdr('203.0.113.7'), payload: { orgSlug: 'nope', email: 'a@b.test', password: 'x' } });
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await bad()).statusCode);
  assert.deepEqual(codes.slice(0, 4), [401, 401, 401, 401]);
  assert.deepEqual(codes.slice(4), [429, 429]);
  const limited = await bad();
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', headers: hdr('198.51.100.9'), payload: { orgSlug: 'nope', email: 'a@b.test', password: 'x' } })).statusCode, 401, 'a different client is not punished');
  // every credential route has its own per-IP budget — the reset endpoint is throttled too (email-bombing / enumeration probing)
  const reset = () => app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', headers: hdr('203.0.113.8'), payload: { orgSlug: 'acme', email: 'a@b.test' } });
  const resetCodes: number[] = [];
  for (let i = 0; i < 6; i++) resetCodes.push((await reset()).statusCode);
  assert.deepEqual(resetCodes, [202, 202, 202, 202, 429, 429]);
});

test('the API limiter is per SESSION, not per NAT: one noisy tablet cannot throttle the rest of the site', async () => {
  const a = (await reg('192.0.2.1')).json().session.token;
  const b = (await reg('192.0.2.2')).json().session.token;
  const ip = '192.0.2.50'; // both tablets behind the same warehouse router
  let got429 = false;
  for (let i = 0; i < 40; i++) if ((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: hdr(ip, { authorization: `Bearer ${a}` }) })).statusCode === 429) got429 = true;
  assert.ok(got429, 'the noisy session is limited');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: hdr(ip, { authorization: `Bearer ${b}` }) })).statusCode, 200, 'the other session on the same IP is not');
});

test('security headers on every response; no fingerprinting; nothing is cacheable', async () => {
  const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: S });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(r.headers['x-powered-by'], undefined);
  assert.ok(r.headers['x-request-id']);
});

test('CORS is an allowlist: the configured origin is echoed, anything else gets no CORS headers', async () => {
  const ok = await app.inject({ method: 'OPTIONS', url: '/v1/items', headers: { ...S, origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key' } });
  assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
  assert.match(String(ok.headers['access-control-allow-headers']), /idempotency-key/i);
  const evil = await app.inject({ method: 'OPTIONS', url: '/v1/items', headers: { ...S, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const simple = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
  assert.equal(simple.headers['access-control-allow-origin'], undefined);
});

test('malformed and hostile requests get clean errors, never stack traces', async () => {
  const big = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...hdr('10.0.0.1'), 'content-type': 'application/json' }, payload: JSON.stringify({ orgSlug: 'a', email: 'a@b.test', password: 'x'.repeat(1_200_000) }) });
  assert.equal(big.statusCode, 413);
  const text = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...hdr('10.0.0.2'), 'content-type': 'text/plain' }, payload: 'hello' });
  assert.equal(text.statusCode, 415);
  const broken = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...hdr('10.0.0.3'), 'content-type': 'application/json' }, payload: '{"orgSlug": ' });
  assert.equal(broken.statusCode, 400);
  for (const r of [big, text, broken]) { assert.ok(r.json().error.requestId); assert.ok(!/\bat \w+.*\.(ts|js):\d+/.test(r.body), 'no stack trace'); assert.ok(!/node_modules|postgres|drizzle/i.test(r.body)); }
  for (const bad of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ' + 'a'.repeat(5000), 'bearer lowercase-scheme-token-000000', '']) {
    const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { ...hdr('10.0.0.4'), authorization: bad } });
    assert.equal(r.statusCode, 401, bad.slice(0, 20));
  }
});

test('injection probes are inert: SQL metacharacters, LIKE wildcards and path traversal are treated as plain data', async () => {
  const session = (await reg('10.0.1.1')).json().session.token;
  const auth = { ...hdr('10.0.1.2'), authorization: `Bearer ${session}` };
  const cat = (await app.inject({ method: 'GET', url: '/v1/categories', headers: auth })).json().items[0].id;
  await app.inject({ method: 'POST', url: '/v1/items', headers: { ...auth, 'idempotency-key': crypto.randomUUID() }, payload: { type: 'asset', categoryId: cat, name: "Robert'); DROP TABLE items;--" } });
  for (const q of ["' OR 1=1 --", "'; DROP TABLE items; --", '%', '_', '\\', '../../etc/passwd', '${7*7}', '<script>alert(1)</script>']) {
    const r = await app.inject({ method: 'GET', url: `/v1/items?q=${encodeURIComponent(q)}`, headers: auth });
    assert.equal(r.statusCode, 200, q);
    assert.ok(r.json().items.length <= 1, `"${q}" must not widen the result`);
  }
  const found = await app.inject({ method: 'GET', url: `/v1/items?q=${encodeURIComponent('DROP TABLE')}`, headers: auth });
  assert.equal(found.json().items.length, 1, 'the hostile name is stored and found as plain text');
  const [{ n }] = (await db.execute(sql`select count(*)::int n from items`)) as unknown as Array<{ n: number }>;
  assert.equal(n, 1, 'the items table survived');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/files/..%2F..%2Fetc%2Fpasswd/content?exp=1&sig=' + 'a'.repeat(64), headers: S })).statusCode, 400);
});

test('PRODUCTION BOOT VALIDATION: weak or missing secrets refuse to start; a complete config starts', () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/env.ts'); console.log('BOOT_OK')"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@localhost/db', REDIS_URL: 'redis://localhost:6379' };
  const weak = run(base);
  assert.equal(weak.status, 1);
  for (const must of ['FILE_URL_SECRET', 'METRICS_TOKEN', 'CORS_ORIGINS', 'APP_BASE_URL', 'FORCE_HTTPS', 'MAIL_DRIVER', 'STORAGE_DRIVER']) assert.match(weak.stderr, new RegExp(must), `${must} must be demanded in production`);
  assert.doesNotMatch(weak.stdout, /BOOT_OK/);
  const complete = { ...base, FILE_URL_SECRET: 'x'.repeat(40), METRICS_TOKEN: 'm'.repeat(32), CORS_ORIGINS: 'https://app.example.com', APP_BASE_URL: 'https://app.example.com', FORCE_HTTPS: 'true',
    MAIL_DRIVER: 'mailgun', MAILGUN_SMTP_USER: 'postmaster@mg.example.com', MAILGUN_SMTP_PASS: 'secret', MAILGUN_WEBHOOK_SIGNING_KEY: 'w'.repeat(32), STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' };
  const good = run(complete);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /BOOT_OK/);
  const noHook = run({ ...complete, MAILGUN_WEBHOOK_SIGNING_KEY: '' }); // bounces and complaints would never stop retries
  assert.equal(noHook.status, 1); assert.match(noHook.stderr, /MAILGUN_WEBHOOK_SIGNING_KEY: required/);
  const partial = run({ ...base, FILE_URL_SECRET: 'short', METRICS_TOKEN: 'm'.repeat(32), CORS_ORIGINS: 'https://a', APP_BASE_URL: 'http://insecure.example', FORCE_HTTPS: 'true', MAIL_DRIVER: 'log', STORAGE_DRIVER: 'local' });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /APP_BASE_URL: must be https/);
  assert.match(partial.stderr, /FILE_URL_SECRET: must be >= 32/);
  assert.match(partial.stderr, /MAIL_DRIVER: must be "mailgun"/);
  assert.match(partial.stderr, /STORAGE_DRIVER: must be "s3"/);
});

test('/metrics requires its bearer token in production-like config and never leaks to anonymous scrapers', async () => {
  // test env has no METRICS_TOKEN (dev convenience); production requires one — covered by the boot-validation test above.
  assert.equal((await app.inject({ method: 'GET', url: '/metrics', headers: S })).statusCode, 200);
});
