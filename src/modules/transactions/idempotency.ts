/**
 * Ledger-level idempotency (PRD §21 "never silently duplicated"; PRD §36 flaky connections & double taps).
 *
 * Protocol, inside the operation's DB transaction:
 *   1. lockKey   — pg_advisory_xact_lock on hash(org, actor, key). Concurrent duplicates of one key
 *                  serialise here; different keys never contend. The lock vanishes at commit/rollback.
 *   2. findByKey — has a ledger row with this key already committed? Then this is a replay: verify the
 *                  request is the SAME request (fingerprint) and return the original outcome.
 *   3. otherwise run the operation; the ledger row is inserted with the key in the same transaction.
 * The unique index (org, actor, key) is the backstop if anything ever bypasses the lock.
 *
 * If the winner rolls back, the waiting duplicate acquires the lock, finds nothing, and performs the
 * operation itself — a failed attempt never poisons a key. A key reused with a different payload is
 * a client bug and is rejected (409), never silently answered with someone else's result.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { transactions } from '../../db/schema.js';
import { ConflictError } from '../../lib/errors.js';
import { metrics } from '../../lib/metrics.js';
import type { TxRow } from './ledger.js';

export async function lockKey(tx: Db, orgId: string, actorId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`idem:${orgId}:${actorId}:${key}`}, 0))`);
}

export async function findByKey(tx: Db, orgId: string, actorId: string, key: string): Promise<TxRow | undefined> {
  const [row] = await tx.select().from(transactions)
    .where(and(eq(transactions.orgId, orgId), eq(transactions.actorUserId, actorId), eq(transactions.idempotencyKey, key))).limit(1);
  return row;
}

export function assertSameRequest(existingFingerprint: string | null, fingerprint: string): void {
  if (existingFingerprint !== fingerprint) throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
}

export const countReplay = (type: string) => metrics.transactions.inc({ type, outcome: 'replayed' });
