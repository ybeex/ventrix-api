/** Pre-rollout configuration review: a good production config is clean; every unsafe variation is reported; the CLI exits non-zero on errors. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkConfig } from '../src/lib/config-check.js';

// Prefer local .env values for this production-config fixture. CI can provide the
// same values through process.env; absent secrets are generated only for the test.
const localEnv = (() => {
  try {
    return Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) return [];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return [[match[1], value]];
    }));
  } catch {
    return {} as Record<string, string>;
  }
})();
const secret = () => randomBytes(32).toString('hex');
const fromEnv = (key: string, fallback?: string) => localEnv[key]?.trim() || process.env[key] || fallback || secret();
const secureDatabaseUrl = () => {
  const candidate = fromEnv('DATABASE_URL', '');
  try {
    const parsed = new URL(candidate);
    if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(parsed.hostname) && /sslmode=(require|verify)|ssl=true/i.test(candidate)) return candidate;
  } catch { /* use an ephemeral test URL below */ }
  return `postgres://app:${secret()}@db.example.net:5432/storekeeper?sslmode=require`;
};
const secureRedisUrl = () => {
  const candidate = fromEnv('REDIS_URL', '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'rediss:' && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(parsed.hostname)) return candidate;
  } catch { /* use an ephemeral test URL below */ }
  return `rediss://app:${secret()}@redis.example.net:6380`;
};

const GOOD = {
  NODE_ENV: 'production', LOAD_SHEDDING: true, FORCE_HTTPS: true, TRUST_PROXY: true, LOG_LEVEL: 'info',
  DATABASE_URL: secureDatabaseUrl(), REDIS_URL: secureRedisUrl(), DB_POOL_MAX: 10,
  CORS_ORIGINS: 'https://app.acme.io', APP_BASE_URL: 'https://app.acme.io',
  FILE_URL_SECRET: fromEnv('FILE_URL_SECRET'), METRICS_TOKEN: fromEnv('METRICS_TOKEN'), MAILGUN_WEBHOOK_SIGNING_KEY: fromEnv('MAILGUN_WEBHOOK_SIGNING_KEY'),
  MAIL_DRIVER: 'mailgun', MAIL_FROM: 'StoreKeeper <no-reply@mg.acme.io>', STORAGE_DRIVER: 's3', S3_REGION: 'eu-west-1', S3_ENDPOINT: '',
  S3_BUCKET: fromEnv('S3_BUCKET', 'sk-prod'), S3_ACCESS_KEY_ID: fromEnv('S3_ACCESS_KEY_ID'), S3_SECRET_ACCESS_KEY: fromEnv('S3_SECRET_ACCESS_KEY'),
  MAILGUN_SMTP_USER: fromEnv('MAILGUN_SMTP_USER', 'postmaster@mg.acme.io'), MAILGUN_SMTP_PASS: fromEnv('MAILGUN_SMTP_PASS'),
  AUTH_RATE_LIMIT_MAX: 10, RATE_LIMIT_MAX: 300, SESSION_TTL_SECONDS: 43200, MAX_LOCATIONS_PER_ORG: 1,
} as const;
const with_ = (over: Record<string, unknown>) => checkConfig({ ...GOOD, ...over } as never);
const has = (f: ReturnType<typeof checkConfig>, key: string, level?: 'error' | 'warn') => f.some((x) => x.key === key && (!level || x.level === level));

test('a correct production configuration produces no findings at all', () => assert.deepEqual(checkConfig(GOOD as never), []));

const BAD: Array<[string, Record<string, unknown>, string, 'error' | 'warn']> = [
  ['not production', { NODE_ENV: 'development' }, 'NODE_ENV', 'error'], ['load shedding off', { LOAD_SHEDDING: false }, 'LOAD_SHEDDING', 'error'],
  ['no https enforcement', { FORCE_HTTPS: false }, 'FORCE_HTTPS', 'error'], ['proxy not trusted', { TRUST_PROXY: false }, 'TRUST_PROXY', 'warn'], ['debug logging', { LOG_LEVEL: 'debug' }, 'LOG_LEVEL', 'warn'],
  ['localhost database', { DATABASE_URL: 'postgres://app:x9Kq@localhost:5432/sk?sslmode=require' }, 'DATABASE_URL', 'error'],
  ['default database credentials', { DATABASE_URL: 'postgres://storekeeper:storekeeper@db.acme.io:5432/sk' }, 'DATABASE_URL', 'error'],
  ['database without TLS', { DATABASE_URL: 'postgres://app:weak-password@db.acme.io:5432/sk' }, 'DATABASE_URL', 'warn'],
  ['localhost redis', { REDIS_URL: 'redis://localhost:6379' }, 'REDIS_URL', 'error'], ['plain redis over network', { REDIS_URL: 'redis://u:weak-password@cache.acme.io:6379' }, 'REDIS_URL', 'warn'],
  ['big pool', { DB_POOL_MAX: 60 }, 'DB_POOL_MAX', 'warn'],
  ['wildcard CORS', { CORS_ORIGINS: '*' }, 'CORS_ORIGINS', 'error'], ['http CORS origin', { CORS_ORIGINS: 'http://app.acme.io' }, 'CORS_ORIGINS', 'error'],
  ['local CORS origin', { CORS_ORIGINS: 'https://app.acme.io,https://localhost:5173' }, 'CORS_ORIGINS', 'error'], ['empty CORS', { CORS_ORIGINS: '' }, 'CORS_ORIGINS', 'error'],
  ['http app url', { APP_BASE_URL: 'http://app.acme.io' }, 'APP_BASE_URL', 'error'], ['app url outside CORS', { APP_BASE_URL: 'https://other.acme.io' }, 'APP_BASE_URL', 'warn'],
  ['placeholder file secret', { FILE_URL_SECRET: 'change-me-change-me-change-me-change-me' }, 'FILE_URL_SECRET', 'error'], ['low-entropy metrics token', { METRICS_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'METRICS_TOKEN', 'warn'],
  ['missing webhook key', { MAILGUN_WEBHOOK_SIGNING_KEY: '' }, 'MAILGUN_WEBHOOK_SIGNING_KEY', 'error'], ['log mailer', { MAIL_DRIVER: 'log' }, 'MAIL_DRIVER', 'error'],
  ['placeholder from address', { MAIL_FROM: 'StoreKeeper <no-reply@mg.example.com>' }, 'MAIL_FROM', 'error'], ['local storage', { STORAGE_DRIVER: 'local' }, 'STORAGE_DRIVER', 'error'],
  ['R2-style region without endpoint', { S3_REGION: 'auto' }, 'S3_REGION', 'warn'], ['loose auth limiter', { AUTH_RATE_LIMIT_MAX: 100 }, 'AUTH_RATE_LIMIT_MAX', 'warn'],
  ['month-long sessions', { SESSION_TTL_SECONDS: 30 * 86_400 }, 'SESSION_TTL_SECONDS', 'warn'], ['multi-location', { MAX_LOCATIONS_PER_ORG: 5 }, 'MAX_LOCATIONS_PER_ORG', 'warn'],
];
for (const [name, over, key, level] of BAD) test(`flags ${name} → ${level} on ${key}`, () => { const f = with_(over); assert.ok(has(f, key, level), JSON.stringify(f)); assert.ok(!JSON.stringify(f).includes(new URL(GOOD.DATABASE_URL).password), 'messages do not echo secrets'); });

test('findings never echo secret values', () => {
  const probe = secret();
  const f = with_({ FILE_URL_SECRET: probe, METRICS_TOKEN: probe });
  assert.ok(f.length > 0); assert.ok(!JSON.stringify(f).includes(probe));
});

test('CLI: exit 1 with a clear report for the unsafe dev-style environment; env.ts boot rules also reject it', () => {
  const r = spawnSync('node', ['--import', 'tsx', 'scripts/check-config.ts'], { env: { PATH: process.env.PATH!, DATABASE_URL: 'postgres://storekeeper:storekeeper@localhost:5432/x', REDIS_URL: 'redis://localhost:6379' }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /Invalid environment configuration[\s\S]*FORCE_HTTPS/);
});

test('CLI: exit 0 for a clean production environment', () => {
  const env = Object.fromEntries(Object.entries({ ...GOOD, FORCE_HTTPS: 'true', TRUST_PROXY: 'true', LOAD_SHEDDING: 'true', DB_POOL_MAX: '10', AUTH_RATE_LIMIT_MAX: '10', RATE_LIMIT_MAX: '300', SESSION_TTL_SECONDS: '43200', MAX_LOCATIONS_PER_ORG: '1',
    S3_BUCKET: 'sk-prod' }).map(([k, v]) => [k, String(v)]));
  const r = spawnSync('node', ['--import', 'tsx', 'scripts/check-config.ts'], { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /no errors/);
});
