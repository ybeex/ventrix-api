/**
 * Cursor pagination, not OFFSET/LIMIT.
 *
 * `OFFSET 50000` forces Postgres to scan and discard 50,000 rows on
 * every request for page 501 — the cost grows with the offset, which
 * is exactly the wrong shape for a table that keeps growing (items,
 * and especially the transactions ledger, at 1M-user scale). Cursor
 * pagination keys off an indexed column instead, so page 501 costs the
 * same as page 1.
 *
 * The cursor is the base64 of `${createdAt.toISOString()}|${id}` — the
 * id tiebreaks rows with an identical timestamp so nothing is ever
 * skipped or repeated across a page boundary. This matters more than
 * it looks: `created_at` alone is not unique (bulk imports, or simply
 * two rows in the same millisecond under real traffic), and without
 * the tiebreak, "resume strictly after this timestamp" can silently
 * skip a same-timestamp row that sorted after the cursor row within
 * the page it was returned in. Every caller must use `keysetWhere`
 * below rather than hand-rolling a `lt(createdAt, cursor.createdAt)`
 * condition — that shortcut compiles fine and is wrong.
 */
import { and, eq, lt, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ValidationError } from './errors.js';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  const createdAt = new Date(iso);
  // A client-supplied cursor is untrusted input: a bad one is a 400, never a 500.
  // The id half is compared against a uuid column, so it must be shaped like one.
  if (Number.isNaN(createdAt.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ValidationError('Malformed pagination cursor');
  }
  return { createdAt, id };
}

/**
 * The WHERE condition for "everything strictly after this cursor",
 * ordered `DESC(createdAt), DESC(id)` — the same order every caller
 * must pass to `.orderBy()`. `(createdAt, id) < (cursor.createdAt,
 * cursor.id)` in row-comparison terms, expressed the way SQL actually
 * needs it: strictly-less-than on createdAt, OR equal-and-less-than on
 * id. Every list endpoint should build its cursor condition through
 * this function, never by hand — see the file header for why the
 * obvious shortcut is a real bug, not just a style nit.
 */
export function keysetWhere(createdAtCol: PgColumn, idCol: PgColumn, cursor: string): SQL {
  const { createdAt, id } = decodeCursor(cursor);
  return or(
    lt(createdAtCol, createdAt),
    and(eq(createdAtCol, createdAt), lt(idCol, id)),
  )!;
}

/** Fetch `limit + 1` rows upstream, then call this to trim and build the cursor. */
export function toPage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const pageItems = hasMore ? rows.slice(0, limit) : rows;
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}


// ── Sequence cursors (ledger & audit log) ──────────────────────────────────────────────────────
// Tables with a monotonic `seq` page on it alone: unique, strictly ordered, immune to timestamp
// precision and to rows that share a transaction timestamp. Cursor = base64url(seq).

export function encodeSeqCursor(seq: number): string {
  return Buffer.from(String(seq), 'utf8').toString('base64url');
}

export function decodeSeqCursor(cursor: string): number {
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(n) || n < 0) throw new ValidationError('Malformed pagination cursor');
  return n;
}

export function toSeqPage<T extends { seq: number }>(rows: T[], limit: number, seqOf: (r: T) => number = (r) => r.seq): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeSeqCursor(seqOf(last)) : null };
}
