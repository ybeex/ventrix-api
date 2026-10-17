/**
 * Production configuration review. `env.ts` already refuses to BOOT with missing or malformed production settings; this goes further
 * and flags values that are *present but unsafe* (placeholder secrets, localhost endpoints, wildcard CORS, weak tokens). Pure function:
 * `scripts/check-config.ts` runs it against the real environment before a rollout, tests run it against crafted ones.
 */
import type { Env } from '../env.js';

export interface ConfigFinding { level: 'error' | 'warn'; key: string; message: string }

const PLACEHOLDER = /change[-_ ]?me|example\.com|your[-_ ]|xxxx|todo|secret123|password|storekeeper:storekeeper/i;
const LOCAL = /(^|[@/])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i;
const distinct = (s: string) => new Set(s).size;

export function checkConfig(e: Partial<Env> & Record<string, unknown>): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const err = (key: string, message: string) => out.push({ level: 'error', key, message });
  const warn = (key: string, message: string) => out.push({ level: 'warn', key, message });
  const s = (k: string) => String(e[k] ?? '');

  if (e.NODE_ENV !== 'production') err('NODE_ENV', `is "${s('NODE_ENV')}", not "production" — dev settings (swagger UI, relaxed checks) would be active`);
  if (e.LOAD_SHEDDING === false) err('LOAD_SHEDDING', 'must stay on in production: under saturation the API should answer 503 + Retry-After instead of slowing every request');
  if (e.FORCE_HTTPS !== true) err('FORCE_HTTPS', 'must be true (the TLS terminator sets X-Forwarded-Proto)');
  if (e.TRUST_PROXY !== true) warn('TRUST_PROXY', 'is off: behind a load balancer every client will share one IP for rate limiting and audit rows');
  if (['debug', 'trace'].includes(s('LOG_LEVEL'))) warn('LOG_LEVEL', `"${s('LOG_LEVEL')}" is verbose and costly in production; use "info"`);

  for (const k of ['DATABASE_URL', 'REDIS_URL']) {
    if (LOCAL.test(s(k))) err(k, 'points at localhost — production must use the managed instance');
    if (PLACEHOLDER.test(s(k))) err(k, 'contains default/placeholder credentials');
  }
  if (!/sslmode=(require|verify)|ssl=true/i.test(s('DATABASE_URL')) && !LOCAL.test(s('DATABASE_URL'))) warn('DATABASE_URL', 'has no sslmode=require (or verify-full); database traffic may be unencrypted');
  if (s('REDIS_URL') && !s('REDIS_URL').startsWith('rediss://') && !LOCAL.test(s('REDIS_URL'))) warn('REDIS_URL', 'is not rediss:// (TLS); fine inside a private network, otherwise encrypt it');
  if (Number(e.DB_POOL_MAX) > 20) warn('DB_POOL_MAX', `${e.DB_POOL_MAX} per instance × instances can exceed Postgres max_connections; put PgBouncer (transaction pooling) in front`);

  const origins = s('CORS_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origins.length) err('CORS_ORIGINS', 'is empty: browsers will be blocked (fail closed)');
  for (const o of origins) {
    if (o === '*') err('CORS_ORIGINS', 'contains "*": any website could call the API with a user\'s token');
    else if (!o.startsWith('https://')) err('CORS_ORIGINS', `"${o}" is not https://`);
    else if (LOCAL.test(o)) err('CORS_ORIGINS', `"${o}" is a local address`);
  }
  if (!s('APP_BASE_URL').startsWith('https://') || LOCAL.test(s('APP_BASE_URL'))) err('APP_BASE_URL', 'must be the public https:// URL of the web app (it is embedded in invite and reset e-mails)');
  else if (origins.length && !origins.some((o) => s('APP_BASE_URL').startsWith(o))) warn('APP_BASE_URL', 'is not among CORS_ORIGINS; the web app at that address could not call the API');

  for (const k of ['FILE_URL_SECRET', 'METRICS_TOKEN', 'MAILGUN_WEBHOOK_SIGNING_KEY']) {
    const v = s(k);
    if (!v) { if (k !== 'MAILGUN_WEBHOOK_SIGNING_KEY' || e.MAIL_DRIVER === 'mailgun') err(k, 'is not set'); continue; }
    if (PLACEHOLDER.test(v)) err(k, 'still looks like a placeholder');
    else if (distinct(v) < 8) warn(k, 'has very low entropy; generate it with `openssl rand -hex 32`');
  }
  if (e.MAIL_DRIVER !== 'mailgun') err('MAIL_DRIVER', `is "${s('MAIL_DRIVER')}": invites and password resets would not be delivered`);
  if (PLACEHOLDER.test(s('MAIL_FROM'))) err('MAIL_FROM', 'uses a placeholder domain; use an address on the domain verified in Mailgun (SPF + DKIM)');
  if (e.STORAGE_DRIVER !== 's3') err('STORAGE_DRIVER', `is "${s('STORAGE_DRIVER')}": local disk is lost on redeploy and not shared between instances`);
  else if (!s('S3_ENDPOINT') && s('S3_REGION') === 'auto') warn('S3_REGION', '"auto" is for Cloudflare R2 and needs S3_ENDPOINT; for AWS S3 set the real region');

  if (Number(e.AUTH_RATE_LIMIT_MAX) > 30) warn('AUTH_RATE_LIMIT_MAX', `${e.AUTH_RATE_LIMIT_MAX}/window on login/reset weakens credential-stuffing protection (default 10)`);
  if (Number(e.RATE_LIMIT_MAX) > 5000) warn('RATE_LIMIT_MAX', 'is very high; the limiter is the first defence against abuse');
  if (Number(e.SESSION_TTL_SECONDS) > 7 * 86_400) warn('SESSION_TTL_SECONDS', 'longer than 7 days: a stolen token stays useful for that long');
  if (Number(e.MAX_LOCATIONS_PER_ORG) !== 1) warn('MAX_LOCATIONS_PER_ORG', 'is not 1: multi-location is Phase 2 and only structurally supported');
  return out;
}
