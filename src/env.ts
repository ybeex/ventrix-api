/**
 * All configuration enters through this one validated object. Nothing else reads
 * `process.env`; a missing or malformed value fails loudly at boot, and production
 * refuses to start with weak or absent secrets instead of "working" insecurely.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Bool = Type.Boolean();
const Int = (def: number, min = 0) => Type.Integer({ default: def, minimum: min });

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')], { default: 'development' }),
  PORT: Int(3000, 1),
  HOST: Type.String({ default: '0.0.0.0' }),
  LOG_LEVEL: Type.String({ default: 'info' }),
  APP_BASE_URL: Type.String({ default: 'http://localhost:5173' }),
  CORS_ORIGINS: Type.String({ default: '' }),
  TRUST_PROXY: Type.Boolean({ default: true }),
  FORCE_HTTPS: Type.Boolean({ default: false }),
  // Reject requests with 503 + Retry-After when the event loop / memory is saturated, instead of slowing every request. Keep ON in production.
  LOAD_SHEDDING: Type.Boolean({ default: true }),

  DATABASE_URL: Type.String({ minLength: 1 }),
  DB_POOL_MAX: Int(10, 1),
  REDIS_URL: Type.String({ minLength: 1 }),

  SESSION_TTL_SECONDS: Int(60 * 60 * 12, 60),
  PIN_SESSION_TTL_SECONDS: Int(60 * 60 * 8, 60),
  INVITE_TTL_SECONDS: Int(60 * 60 * 24 * 7, 60),
  PASSWORD_RESET_TTL_SECONDS: Int(60 * 60, 60),
  IDEMPOTENCY_KEY_TTL_SECONDS: Int(60 * 60 * 24, 60),

  RATE_LIMIT_MAX: Int(300, 1),
  RATE_LIMIT_WINDOW_MS: Int(60_000, 1000),
  AUTH_RATE_LIMIT_MAX: Int(10, 1),
  MAX_LOCATIONS_PER_ORG: Int(1, 1),
  INLINE_IMPORT_MAX_ROWS: Int(500, 1),
  MAX_IMPORT_BYTES: Int(5 * 1024 * 1024, 1024),
  MAX_IMPORT_ROWS: Int(10_000, 1),

  STORAGE_DRIVER: Type.Union([Type.Literal('local'), Type.Literal('s3')], { default: 'local' }),
  STORAGE_LOCAL_DIR: Type.String({ default: '.storage' }),
  MAX_UPLOAD_BYTES: Int(5 * 1024 * 1024, 1024),
  FILE_URL_TTL_SECONDS: Int(300, 10),
  FILE_URL_SECRET: Type.String({ default: '' }),
  S3_BUCKET: Type.String({ default: '' }),
  S3_REGION: Type.String({ default: 'auto' }),
  S3_ENDPOINT: Type.String({ default: '' }),
  S3_ACCESS_KEY_ID: Type.String({ default: '' }),
  S3_SECRET_ACCESS_KEY: Type.String({ default: '' }),

  MAIL_DRIVER: Type.Union([Type.Literal('mailgun'), Type.Literal('log'), Type.Literal('json')], { default: 'log' }),
  MAIL_FROM: Type.String({ default: 'StoreKeeper <no-reply@localhost>' }),
  MAILGUN_SMTP_HOST: Type.String({ default: 'smtp.mailgun.org' }),
  MAILGUN_SMTP_PORT: Int(587, 1),
  MAILGUN_SMTP_USER: Type.String({ default: '' }),
  MAILGUN_SMTP_PASS: Type.String({ default: '' }),

  CB_TIMEOUT_MS: Int(8000, 100),
  CB_ERROR_THRESHOLD_PCT: Int(50, 1),
  CB_RESET_TIMEOUT_MS: Int(30_000, 100),
  CB_VOLUME_THRESHOLD: Int(5, 1),

  METRICS_TOKEN: Type.String({ default: '' }),
});

export type Env = Static<typeof EnvSchema>;

function coerce(raw: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(EnvSchema.properties)) {
    const v = raw[key];
    if (v === undefined || v === '') continue;
    const kind = (schema as { type?: string }).type;
    if (kind === 'integer') out[key] = Number(v);
    else if (kind === 'boolean') out[key] = v === 'true' || v === '1';
    else out[key] = v;
  }
  return out;
}

function loadEnv(): Env {
  const withDefaults = Value.Default(EnvSchema, coerce(process.env)) as Env;
  const problems: string[] = [...Value.Errors(EnvSchema, withDefaults)].map((e) => `${e.path}: ${e.message}`);

  if (problems.length === 0 && withDefaults.NODE_ENV === 'production') {
    const e = withDefaults;
    if (e.FILE_URL_SECRET.length < 32) problems.push('FILE_URL_SECRET: must be >= 32 chars in production');
    if (e.METRICS_TOKEN.length < 24) problems.push('METRICS_TOKEN: must be >= 24 chars in production');
    if (!e.CORS_ORIGINS) problems.push('CORS_ORIGINS: must be set in production');
    if (!e.APP_BASE_URL.startsWith('https://')) problems.push('APP_BASE_URL: must be https:// in production');
    if (!e.FORCE_HTTPS) problems.push('FORCE_HTTPS: must be true in production');
    if (e.MAIL_DRIVER !== 'mailgun') problems.push('MAIL_DRIVER: must be "mailgun" in production');
    if (e.MAIL_DRIVER === 'mailgun' && (!e.MAILGUN_SMTP_USER || !e.MAILGUN_SMTP_PASS)) problems.push('MAILGUN_SMTP_USER/PASS: required');
    if (e.STORAGE_DRIVER !== 's3') problems.push('STORAGE_DRIVER: must be "s3" in production (local disk does not scale across instances)');
    if (e.STORAGE_DRIVER === 's3' && (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY)) problems.push('S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY: required');
  }
  if (problems.length === 0 && withDefaults.STORAGE_DRIVER === 'local' && withDefaults.FILE_URL_SECRET.length < 16) {
    // Dev/test convenience only: a random per-process secret (signed URLs die on restart, which is fine locally).
    (withDefaults as { FILE_URL_SECRET: string }).FILE_URL_SECRET = `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }

  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  return withDefaults;
}

export const env = loadEnv();
