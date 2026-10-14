/** E-mail outbox ordering. Regression for AUDIT-FINDINGS F-WS1-1: UPDATE … RETURNING does not preserve the subquery's ORDER BY. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { sentMessages } from '../src/modules/mail/mailer.js';
import { dispatchDueEmails, enqueueEmail } from '../src/modules/mail/outbox.js';
import { makeApp, resetAll, type App } from './helpers.js';

let app: App;
before(async () => { app = await makeApp(); await resetAll(app); });
after(async () => { await app.close(); });

test('REGRESSION: mails are SENT in the order they were queued, even after churn has reordered the heap', async () => {
  for (let i = 0; i < 12; i++) {
    sentMessages.length = 0;
    await enqueueEmail(db, { orgId: null, to: 'x@acme.test', subject: `first-${i}`, text: 'old link' });
    await new Promise((r) => setTimeout(r, 4));
    await enqueueEmail(db, { orgId: null, to: 'x@acme.test', subject: `second-${i}`, text: 'new link' });
    // touching the older row (what a retry/backoff update does) relocates its tuple behind the newer one
    await db.execute(sql`update email_outbox set last_error = 'touch' where subject = ${`first-${i}`}`);
    await dispatchDueEmails(db);
    assert.deepEqual(sentMessages.map((m) => m.subject), [`first-${i}`, `second-${i}`], `trial ${i}`);
  }
});

test('a claimed batch respects the batch size and leaves the rest queued, oldest first', async () => {
  await db.execute(sql`truncate email_outbox`);
  for (let i = 0; i < 5; i++) { await enqueueEmail(db, { orgId: null, to: 'y@acme.test', subject: `m${i}`, text: 't' }); await new Promise((r) => setTimeout(r, 3)); }
  sentMessages.length = 0;
  const r = await dispatchDueEmails(db, 3);
  assert.equal(r.sent, 3); assert.deepEqual(sentMessages.map((m) => m.subject), ['m0', 'm1', 'm2']);
  await dispatchDueEmails(db, 3);
  assert.deepEqual(sentMessages.map((m) => m.subject), ['m0', 'm1', 'm2', 'm3', 'm4']);
});
