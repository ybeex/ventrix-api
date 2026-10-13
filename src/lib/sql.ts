/** Escapes LIKE/ILIKE metacharacters so user input is matched literally (Postgres' default escape char is backslash). */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export const contains = (s: string): string => `%${likeEscape(s.trim())}%`;
export const prefix = (s: string): string => `${likeEscape(s.trim())}%`;

import { sql, type SQL } from 'drizzle-orm';

/**
 * A timestamp parameter for RAW sql`` templates. Drizzle only converts Dates for typed column operators; in raw SQL the
 * Date reaches postgres.js untyped, and with `prepare: false` (mandatory behind PgBouncer) it cannot infer the type and throws.
 * Sending an ISO string with an explicit cast is unambiguous and pooler-safe.
 */
export const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** Raw `db.execute()` rows carry timestamps as strings (only typed select() maps them to Date). Normalise at the query boundary. */
export const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(v as string));
