import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { itemCounters } from '../db/schema.js';

/** Gapless per-(org, prefix) counter: one atomic upsert, rolled back with the surrounding transaction (no gaps on failure). */
export async function nextCounterValue(tx: Db, orgId: string, prefix: string): Promise<number> {
  const [row] = await tx.insert(itemCounters).values({ orgId, prefix, nextValue: 2 })
    .onConflictDoUpdate({ target: [itemCounters.orgId, itemCounters.prefix], set: { nextValue: sql`${itemCounters.nextValue} + 1` } })
    .returning({ n: sql<number>`${itemCounters.nextValue} - 1` });
  return row.n;
}
