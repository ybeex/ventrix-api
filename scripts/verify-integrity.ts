/** Runs the ledger integrity oracle over whatever DATABASE_URL points at (used after seeding and after load tests). */
import { db } from '../src/db/index.js';
import { findViolations } from '../src/modules/integrity/service.js';
const t = Date.now(); const v = await findViolations(db);
console.log(JSON.stringify({ violations: v.length, ms: Date.now() - t, sample: v.slice(0, 3) }));
process.exit(v.length ? 1 : 0);
