/**
 * Transactional e-mail outbox. Features write a row inside the DB transaction that caused the mail
 * (so mail exists iff the change committed); `dispatchDueEmails` — run by the worker every few seconds —
 * claims due rows with SKIP LOCKED (many workers can run safely), sends OUTSIDE any DB transaction
 * (no row locks held across network I/O), and records the outcome.
 *
 * A claim pushes `next_attempt_at` forward as a visibility timeout, so a worker that crashes mid-send
 * simply lets the row become due again. Failures back off exponentially (30s, 1m, 2m … capped 1h) and
 * after MAX_ATTEMPTS the row is marked failed for a human to look at — never silently dropped.
 * An open Mailgun circuit is not a failure of the row: it is deferred without consuming an attempt.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { emailOutbox } from '../../db/schema.js';
import { DependencyUnavailableError } from '../../lib/errors.js';
import { metrics } from '../../lib/metrics.js';
import { sendMail } from './mailer.js';

const MAX_ATTEMPTS = 8;
const CLAIM_VISIBILITY_SECONDS = 120;

export async function enqueueEmail(
  tx: Db,
  mail: { orgId: string | null; to: string; subject: string; text: string; html?: string },
): Promise<void> {
  await tx.insert(emailOutbox).values({ orgId: mail.orgId, toEmail: mail.to, subject: mail.subject, textBody: mail.text, htmlBody: mail.html ?? null });
}

export interface DispatchResult { sent: number; failed: number; deferred: number }

export async function dispatchDueEmails(db: Db, batch = 20): Promise<DispatchResult> {
  const claimed = await db.execute<{
    id: string; to_email: string; subject: string; text_body: string; html_body: string | null; attempts: number;
  }>(sql`
    update email_outbox set
      next_attempt_at = now() + make_interval(secs => ${CLAIM_VISIBILITY_SECONDS}),
      attempts = attempts + 1
    where id in (
      select id from email_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at
      limit ${batch}
      for update skip locked
    )
    returning id, to_email, subject, text_body, html_body, attempts
  `);
  const rows = Array.isArray(claimed) ? claimed : (claimed as unknown as { rows: typeof claimed }).rows;

  const result: DispatchResult = { sent: 0, failed: 0, deferred: 0 };
  for (const r of rows) {
    try {
      await sendMail({ to: r.to_email, subject: r.subject, text: r.text_body, html: r.html_body ?? undefined });
      await db.update(emailOutbox).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(emailOutbox.id, r.id));
      metrics.emails.inc({ outcome: 'sent' });
      result.sent++;
    } catch (err) {
      if (err instanceof DependencyUnavailableError) {
        // Mailgun is unhealthy: give the attempt back and retry shortly. Not the row's fault.
        await db.update(emailOutbox).set({ attempts: sql`greatest(${emailOutbox.attempts} - 1, 0)`, nextAttemptAt: sql`now() + interval '30 seconds'` }).where(eq(emailOutbox.id, r.id));
        metrics.emails.inc({ outcome: 'deferred' });
        result.deferred++;
        continue;
      }
      const dead = r.attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(30 * 2 ** (r.attempts - 1), 3600);
      await db.update(emailOutbox).set({
        status: dead ? 'failed' : 'pending',
        lastError: String((err as Error).message ?? err).slice(0, 500),
        nextAttemptAt: sql`now() + make_interval(secs => ${backoffSeconds})`,
      }).where(eq(emailOutbox.id, r.id));
      metrics.emails.inc({ outcome: dead ? 'dead' : 'retry' });
      result.failed++;
    }
  }
  return result;
}
