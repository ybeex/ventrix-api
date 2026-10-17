/**
 * Pre-rollout configuration check.   NODE_ENV is forced to "production" so the boot-time rules in env.ts apply too.
 *   node --import tsx scripts/check-config.ts            static review of the environment (no network)
 *   node --import tsx scripts/check-config.ts --connect  also: Postgres + Redis reachable, migrations applied, custody trigger present
 * Exit code: 0 = no errors (warnings allowed), 1 = errors. Run it with the SAME variables the API and worker will get.
 */
process.env.NODE_ENV = 'production';
const { checkConfig } = await import('../src/lib/config-check.js');
let env: Awaited<typeof import('../src/env.js')>['env'];
try { ({ env } = await import('../src/env.js')); } catch (e) { console.error(`✗ env.ts refused to load the configuration:\n${(e as Error).message}`); process.exit(1); }

const findings = checkConfig(env as never);
const connectFindings: typeof findings = [];
if (process.argv.includes('--connect')) {
  const { sql } = await import('drizzle-orm'); const { db } = await import('../src/db/index.js'); const { default: Redis } = await import('ioredis');
  const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
  try {
    await db.execute(sql`select 1`);
    const [m] = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`).catch(() => [{ n: 0 }] as never));
    const { readFileSync } = await import('node:fs'); const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.length;
    if (m.n < journal) connectFindings.push({ level: 'error', key: 'MIGRATIONS', message: `${m.n} of ${journal} migrations applied — run \`npm run db:migrate\` before starting the new version` });
    const [t] = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from pg_trigger where tgname in ('transactions_immutable','transactions_custody','audit_events_immutable') and not tgisinternal`));
    if (t.n < 3) connectFindings.push({ level: 'error', key: 'TRIGGERS', message: `${t.n} of 3 ledger/audit triggers present — the post-migration SQL did not run` });
    const [r] = rows<{ c: string | null }>(await db.execute(sql`select to_regclass('public.custody_balances')::text as c`)); if (!r.c) connectFindings.push({ level: 'error', key: 'CUSTODY_BALANCES', message: 'table missing — run `npm run db:migrate`' });
  } catch (e) { connectFindings.push({ level: 'error', key: 'DATABASE_URL', message: `cannot connect/query: ${(e as Error).message}` }); }
  try { const rd = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 1 }); await rd.connect(); await rd.ping(); rd.disconnect(); }
  catch (e) { connectFindings.push({ level: 'error', key: 'REDIS_URL', message: `cannot connect: ${(e as Error).message}` }); }
}
const all = [...findings, ...connectFindings];
for (const f of all) console.log(`${f.level === 'error' ? '✗ ERROR' : '! warn '}  ${f.key}: ${f.message}`);
const errors = all.filter((f) => f.level === 'error').length, warns = all.length - errors;
console.log(errors ? `\n${errors} error(s), ${warns} warning(s) — do not roll out.` : `\n✓ no errors (${warns} warning${warns === 1 ? '' : 's'}).`);
process.exit(errors ? 1 : 0);
