import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db } from '../src/db/index.js';
import { makeApp, resetAll, type App } from './helpers.js';
import accessPlugin from '../src/plugins/access.js';
import authPlugin from '../src/plugins/auth.js';

let app: App;
before(async () => { app = await makeApp(); await resetAll(app); });
after(async () => { await app.close(); });

test('liveness and readiness', async () => {
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  const r = await app.inject('/readyz');
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.db, true);
  assert.equal(body.redis, true);
});

test('unknown route uses the standard error envelope', async () => {
  const r = await app.inject('/v1/nope');
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error.code, 'NOT_FOUND');
  assert.ok(r.json().error.requestId);
});

test('responses are no-store and carry a request id; hostile request ids are replaced', async () => {
  const r = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'bad id with spaces & <script>' } });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  const ok = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'trace-abc-12345' } });
  assert.equal(ok.headers['x-request-id'], 'trace-abc-12345');
});

test('metrics endpoint exposes breaker + http metrics', async () => {
  await app.inject('/healthz');
  const r = await app.inject('/metrics');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /http_request_duration_seconds/);
  assert.match(r.body, /circuit_breaker_state\{name="redis"\}/);
});

/** A throwaway Fastify that borrows the main app's connections (so closing it can't tear down shared pools). */
async function probeApp(): Promise<ReturnType<typeof Fastify>> {
  const probe = Fastify();
  probe.decorate('db', db);
  probe.decorate('redis', app.redis);
  probe.decorate('cache', app.cache);
  await probe.register(authPlugin);
  await probe.register(accessPlugin);
  return probe;
}

test('FAIL CLOSED: a route that declares no access config makes the app refuse to boot', async () => {
  const bare = await probeApp();
  await assert.rejects(
    async () => { bare.get('/oops', async () => 'forgot to declare access'); await bare.ready(); },
    /must declare config\.public or a valid config\.permission/,
  );
});

test('FAIL CLOSED: an unknown permission name is also refused', async () => {
  const bare = await probeApp();
  await assert.rejects(
    async () => { bare.get('/oops', { config: { permission: 'items:everything' as never } }, async () => 'x'); await bare.ready(); },
    /valid config\.permission/,
  );
});

test('protected routes reject missing and garbage tokens BEFORE validation (no schema leakage to anonymous callers)', async () => {
  const probe = await probeApp();
  probe.post('/secret', { config: { permission: 'items:read' }, schema: { body: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } } }, async () => 'ok');
  await probe.ready();
  const noToken = await probe.inject({ method: 'POST', url: '/secret', payload: {} });
  assert.equal(noToken.statusCode, 401);
  const garbage = await probe.inject({ method: 'POST', url: '/secret', headers: { authorization: 'Bearer ' + 'x'.repeat(43) }, payload: { x: 'a' } });
  assert.equal(garbage.statusCode, 401);
  await probe.close();
});
