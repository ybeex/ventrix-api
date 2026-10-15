/** Times the real query functions behind the heavy screens (3 runs each: first is cold). node --import tsx scripts/time-queries.ts */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { categoryStats, dashboardCounts, lowStockPage, outstandingPage } from '../src/modules/operations/queries.js';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const [{ id: orgId }] = rows<{ id: string }>(await db.execute(sql`select id from organizations where slug = ${process.env.SEED_ORG_SLUG ?? 'load-big'}`));
const time = async (name: string, f: () => Promise<unknown>) => { const t: number[] = []; for (let i = 0; i < 3; i++) { const s = performance.now(); await f(); t.push(Math.round(performance.now() - s)); } console.log(`${name.padEnd(34)} ${t.map((x) => String(x).padStart(6)).join(' ')} ms`); };
await time('dashboardCounts', () => dashboardCounts(db, orgId, 'Africa/Lagos', 24, 10));
await time('outstandingPage(50)', () => outstandingPage(db, orgId, { limit: 50 } as never));
await time('categoryStats (Collections)', () => categoryStats(db, orgId, 10));
await time('lowStockPage(50, near)', () => lowStockPage(db, orgId, { limit: 50, includeNear: true, nearPct: 10 } as never));
process.exit(0);
