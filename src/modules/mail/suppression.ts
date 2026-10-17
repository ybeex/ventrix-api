/**
 * Mail suppression list + Mailgun webhook signature check.
 *
 * Mailgun reports hard bounces, spam complaints and unsubscribes by HTTP webhook. Retrying a dead address
 * hurts the sending domain's reputation, so such an address is suppressed: pending mail to it is cancelled
 * and nothing is ever sent to it again (until an operator removes the row).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe';
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** Mailgun signs `timestamp + token` with the HTTP webhook signing key (HMAC-SHA256, hex). Rejects stale timestamps (replay window). */
export function verifyMailgunSignature(key: string, sig: { timestamp: string; token: string; signature: string }, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  if (!key) return false; // no key configured → the webhook accepts nothing
  const ts = Number(sig.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;
  const expected = createHmac('sha256', key).update(sig.timestamp + sig.token).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig.signature.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function isSuppressed(db: Db, email: string): Promise<SuppressionReason | null> {
  const r = rowsOf<{ reason: SuppressionReason }>(await db.execute(sql`select reason from email_suppressions where email = ${normalizeEmail(email)}`));
  return r[0]?.reason ?? null;
}

/** Idempotent. Also cancels mail still waiting to go to that address. Returns how many queued messages were cancelled. */
export async function suppress(db: Db, a: { email: string; reason: SuppressionReason; eventId?: string; detail?: string }): Promise<number> {
  const email = normalizeEmail(a.email);
  await db.execute(sql`
    insert into email_suppressions (email, reason, event_id, detail) values (${email}, ${a.reason}, ${a.eventId ?? null}, ${(a.detail ?? '').slice(0, 500) || null})
    on conflict (email) do update set reason = excluded.reason, event_id = excluded.event_id, detail = excluded.detail, updated_at = now()`);
  const cancelled = rowsOf<{ id: string }>(await db.execute(sql`
    update email_outbox set status = 'failed', last_error = ${`recipient suppressed (${a.reason})`}
    where status = 'pending' and lower(to_email) = ${email} returning id`));
  return cancelled.length;
}
