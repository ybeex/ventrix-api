/** Housekeeping and self-checks run by the worker. None of them ever touches the immutable ledger/audit tables. */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { metrics } from '../../lib/metrics.js';
import { findViolations } from '../integrity/service.js';

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const n = async (db: Db, q: ReturnType<typeof sql>) => rowsOf(await db.execute(q)).length;

export async function purgeExpired(db: Db) {
  return {
    sessions: await n(db, sql`delete from sessions where expires_at < now() returning id`),
    authTokens: await n(db, sql`delete from auth_tokens where expires_at < now() - interval '7 days' or (used_at is not null and used_at < now() - interval '7 days') returning id`),
    idempotencyKeys: await n(db, sql`delete from idempotency_keys where expires_at < now() returning id`),
    domainEvents: await n(db, sql`delete from domain_events where processed_at is not null and processed_at < now() - interval '30 days' returning id`),
    emails: await n(db, sql`delete from email_outbox where status = 'sent' and sent_at < now() - interval '30 days' returning id`),
    notifications: await n(db, sql`delete from notifications where read_at is not null and read_at < now() - interval '90 days' returning id`),
    // An import left "committing" by a crashed worker becomes retryable (per-row idempotency makes the retry safe).
    stuckImports: await n(db, sql`update import_jobs set status = 'failed' where status = 'committing' and started_at < now() - interval '30 minutes' returning id`),
  };
}

export async function auditIntegrity(db: Db): Promise<number> {
  const v = await findViolations(db);
  metrics.integrityViolations.set(v.length);
  if (v.length) console.error(JSON.stringify({ level: 'error', msg: 'LEDGER INTEGRITY VIOLATIONS', count: v.length, sample: v.slice(0, 20) })); // alert on this
  return v.length;
}
