/** REGRESSION (WS5 failure drill): with Postgres down the API answered 500 INTERNAL_ERROR; an outage must be a retryable 503 so clients and alerting can tell it from a bug. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import errorHandler from '../src/plugins/error-handler.js';
import { isConnectionFailure } from '../src/lib/db-errors.js';

const boom = (e: unknown) => async () => { const app = Fastify(); await app.register(errorHandler); app.get('/x', async () => { throw e; }); const r = await app.inject({ url: '/x' }); await app.close(); return r; };
const withCode = (code: string, msg = 'driver said no') => Object.assign(new Error(msg), { code });
const wrapped = (inner: Error) => Object.assign(new Error('Failed query: select 1'), { cause: inner });

for (const [name, err] of [
  ['connection refused (postgres.js)', withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432')],
  ['connection reset', withCode('ECONNRESET')], ['connection ended', withCode('CONNECTION_ENDED')], ['connection closed', withCode('CONNECTION_CLOSED')],
  ['connect timeout', withCode('CONNECT_TIMEOUT')], ['host unreachable', withCode('EHOSTUNREACH')],
  ['admin shutdown 57P01', withCode('57P01')], ['cannot connect now 57P03', withCode('57P03')], ['connection exception 08006', withCode('08006')], ['too many connections 53300', withCode('53300')],
  ['wrapped by drizzle (.cause)', wrapped(withCode('ECONNREFUSED'))],
] as const) {
  test(`database outage → 503 + Retry-After, no internals leaked: ${name}`, async () => {
    assert.equal(isConnectionFailure(err), true);
    const r = await boom(err)();
    assert.equal(r.statusCode, 503, r.body); assert.equal(r.json().error.code, 'TEMPORARILY_UNAVAILABLE'); assert.ok(Number(r.headers['retry-after']) >= 1);
    assert.ok(!/ECONN|127\.0\.0\.1|select 1|driver/i.test(r.body), 'the response never carries driver text');
  });
}

test('everything else keeps its meaning: unique violation 409, FK 422, constraint 409, unknown error 500 (generic message)', async () => {
  assert.equal((await boom(withCode('23505'))()).statusCode, 409); assert.equal((await boom(withCode('23503'))()).statusCode, 422); assert.equal((await boom(withCode('23514'))()).statusCode, 409);
  const r = await boom(new Error('secret table name users_pw'))(); assert.equal(r.statusCode, 500); assert.ok(!r.body.includes('secret')); assert.equal(isConnectionFailure(new Error('x')), false);
  assert.equal(isConnectionFailure(withCode('42P01')), false, 'an undefined table is a bug, not an outage'); assert.equal(isConnectionFailure(null), false);
});
