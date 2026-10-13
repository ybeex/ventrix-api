/**
 * Applies, in order: drizzle/manual/pre/*.sql (extensions) → generated migrations → drizzle/manual/post/*.sql
 * (triggers). Every manual file is idempotent, so this is safe to run on every deploy.
 * Reads DATABASE_URL directly: it must work without the app's other required config.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

export async function runMigrations(databaseUrl: string, root = process.cwd()): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const runDir = async (dir: string) => {
      const full = join(root, 'drizzle/manual', dir);
      for (const f of readdirSync(full).filter((x) => x.endsWith('.sql')).sort()) {
        await sql.unsafe(readFileSync(join(full, f), 'utf8'));
      }
    };
    await runDir('pre');
    await migrate(drizzle(sql), { migrationsFolder: join(root, 'drizzle') });
    await runDir('post');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
  runMigrations(url).then(() => { console.log('migrations applied'); }).catch((e) => { console.error(e); process.exit(1); });
}
