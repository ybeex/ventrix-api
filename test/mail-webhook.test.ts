/** Mailgun bounce / complaint / unsubscribe webhook → suppression list → the outbox stops mailing (and retrying) that address. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { env } from '../src/env.js';
import { sentMessages } from '../src/modules/mail/mailer.js';
import { enqueueEmail } from '../src/modules/mail/outbox.js';
import { verifyMailgunSignature } from '../src/modules/mail/suppression.js';
import { makeApp, resetAll, registerOrg, callIdem, flushMail, type App, type Session } from './helpers.js';

const KEY = 'whsec-test-signing-key-0123456789';
let app: App; let admin: Session;
before(async () => { app = await makeApp(); (env as { MAILGUN_WEBHOOK_SIGNING_KEY: string }).MAILGUN_WEBHOOK_SIGNING_KEY = KEY; });
after(async () => { (env as { MAILGUN_WEBHOOK_SIGNING_KEY: string }).MAILGUN_WEBHOOK_SIGNING_KEY = ''; await app.close(); });
beforeEach(async () => { await resetAll(app); admin = await registerOrg(app); sentMessages.length = 0; });

const rows = (r: unknown) => Array.from((Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<Record<string, any>>);
const sign = (token = crypto.randomUUID().replace(/-/g, ''), ts = String(Math.floor(Date.now() / 1000)), key = KEY) => ({ timestamp: ts, token, signature: createHmac('sha256', key).update(ts + token).digest('hex') });
const hook = (data: Record<string, unknown>, signature = sign()) => app.inject({ method: 'POST', url: '/v1/webhooks/mailgun', payload: { signature, 'event-data': { id: 'evt-1', ...data } } });
const suppressions = async () => rows(await db.execute(sql`select email, reason, event_id, detail from email_suppressions order by email`));
const outbox = async (to: string) => rows(await db.execute(sql`select status, last_error, attempts from email_outbox where to_email = ${to} order by created_at`));
const queue = (to: string) => enqueueEmail(db, { orgId: null, to, subject: `Hello ${to}`, text: 'hi' });

test('signature check: valid; wrong key; tampered token; stale and future timestamps; empty key accepts nothing; malformed hex', () => {
  const now = Date.now(); const ok = sign('tok-0123456789'); assert.equal(verifyMailgunSignature(KEY, ok, now), true);
  assert.equal(verifyMailgunSignature('another-key-another-key-123', ok, now), false); assert.equal(verifyMailgunSignature(KEY, { ...ok, token: 'tok-0123456780' }, now), false);
  assert.equal(verifyMailgunSignature(KEY, ok, now + 301_000), false, 'stale'); assert.equal(verifyMailgunSignature(KEY, ok, now - 301_000), false, 'from the future');
  assert.equal(verifyMailgunSignature('', sign('tok-0123456789', ok.timestamp, ''), now), false, 'no key configured → reject everything');
  assert.equal(verifyMailgunSignature(KEY, { ...ok, signature: 'zz' }, now), false); assert.equal(verifyMailgunSignature(KEY, { ...ok, timestamp: 'abc' }, now), false);
  assert.equal(verifyMailgunSignature(KEY, { ...ok, signature: ok.signature.toUpperCase() }, now), true, 'hex case does not matter');
});

test('bad signature / stale timestamp / unconfigured key → 401 and nothing changes', async () => {
  assert.equal((await hook({ event: 'failed', severity: 'permanent', recipient: 'x@acme.test' }, sign(undefined, undefined, 'wrong-wrong-wrong-wrong'))).statusCode, 401);
  const stale = await hook({ event: 'failed', severity: 'permanent', recipient: 'x@acme.test' }, sign(undefined, String(Math.floor(Date.now() / 1000) - 3600))); assert.equal(stale.statusCode, 401); assert.equal(stale.json().error.code, 'INVALID_SIGNATURE');
  (env as { MAILGUN_WEBHOOK_SIGNING_KEY: string }).MAILGUN_WEBHOOK_SIGNING_KEY = '';
  try { assert.equal((await hook({ event: 'failed', severity: 'permanent', recipient: 'x@acme.test' }, sign(undefined, undefined, ''))).statusCode, 401, 'no key configured'); } finally { (env as { MAILGUN_WEBHOOK_SIGNING_KEY: string }).MAILGUN_WEBHOOK_SIGNING_KEY = KEY; }
  assert.deepEqual(await suppressions(), []);
});

test('permanent failure = bounce: suppressed (lower-cased), queued mail to that address is cancelled, others untouched', async () => {
  await queue('Dead@Acme.test'); await queue('dead@acme.test'); await queue('alive@acme.test');
  const r = await hook({ event: 'failed', severity: 'permanent', recipient: ' Dead@Acme.test ', 'delivery-status': { message: '550 5.1.1 mailbox does not exist', code: 550 }, extra: { anything: true } });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().status, 'suppressed');
  const s = await suppressions(); assert.equal(s.length, 1); assert.deepEqual([s[0].email, s[0].reason, s[0].event_id], ['dead@acme.test', 'bounce', 'evt-1']); assert.match(s[0].detail, /mailbox does not exist/);
  for (const to of ['Dead@Acme.test', 'dead@acme.test']) assert.deepEqual((await outbox(to)).map((o) => [o.status, o.last_error]), [['failed', 'recipient suppressed (bounce)']]);
  assert.equal((await outbox('alive@acme.test'))[0].status, 'pending');
  await flushMail(); assert.deepEqual(sentMessages.map((m) => m.to), ['alive@acme.test'], 'only the live address is mailed');
});

test('complaint and unsubscribe suppress too; temporary failures and other events are ignored (Mailgun retries those)', async () => {
  assert.equal((await hook({ event: 'complained', recipient: 'angry@acme.test' })).json().status, 'suppressed');
  assert.equal((await hook({ event: 'unsubscribed', recipient: 'bye@acme.test' })).json().status, 'suppressed');
  for (const d of [{ event: 'failed', severity: 'temporary', recipient: 'full@acme.test' }, { event: 'delivered', recipient: 'ok@acme.test' }, { event: 'opened', recipient: 'ok2@acme.test' }]) assert.equal((await hook(d)).json().status, 'ignored');
  assert.deepEqual((await suppressions()).map((s) => [s.email, s.reason]), [['angry@acme.test', 'complaint'], ['bye@acme.test', 'unsubscribe']]);
});

test('replay: the same signature token twice is answered "duplicate" the second time; a re-suppression with a new token is idempotent and updates the reason', async () => {
  const sig = sign('one-time-token-0001'); assert.equal((await hook({ event: 'failed', severity: 'permanent', recipient: 'a@acme.test' }, sig)).json().status, 'suppressed');
  assert.equal((await hook({ event: 'failed', severity: 'permanent', recipient: 'a@acme.test' }, sig)).json().status, 'duplicate');
  assert.equal((await hook({ event: 'complained', recipient: 'a@acme.test', id: 'evt-2' })).json().status, 'suppressed');
  const s = await suppressions(); assert.equal(s.length, 1); assert.deepEqual([s[0].reason, s[0].event_id], ['complaint', 'evt-2']);
});

test('the outbox never sends to a suppressed address, never retries it, and counts it', async () => {
  await db.execute(sql`insert into email_suppressions (email, reason) values ('gone@acme.test', 'bounce')`);
  await queue('GONE@acme.test'); await queue('here@acme.test'); await flushMail();
  assert.deepEqual(sentMessages.map((m) => m.to), ['here@acme.test']);
  const o = await outbox('GONE@acme.test'); assert.deepEqual([o[0].status, o[0].last_error, o[0].attempts], ['failed', 'recipient suppressed (bounce)', 1]);
  await flushMail(); assert.equal((await outbox('GONE@acme.test'))[0].attempts, 1, 'not retried');
});

test('invites to a bounced address are accepted (201) but no mail goes out, and everyone else still gets theirs', async () => {
  await hook({ event: 'failed', severity: 'permanent', recipient: 'nobody@acme.test' });
  assert.equal((await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'nobody@acme.test', role: 'viewer' })).statusCode, 201);
  assert.equal((await callIdem(app, admin.token, 'POST', '/users/invitations', { email: 'somebody@acme.test', role: 'viewer' })).statusCode, 201);
  await flushMail(); assert.deepEqual(sentMessages.map((m) => m.to), ['somebody@acme.test']);
});

test('malformed payloads are 400, and the endpoint needs no bearer token (public) but is not open: it is the signature that authenticates', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/v1/webhooks/mailgun', payload: { hello: 'world' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/webhooks/mailgun', payload: { signature: sign(), 'event-data': { event: 'failed' } } })).statusCode, 400, 'recipient required');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/webhooks/mailgun' })).statusCode, 404);
});
