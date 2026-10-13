import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** 256 bits of CSPRNG output, URL-safe. This is the bearer token the client holds. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this hash is ever persisted (Postgres `sessions.token_hash`,
 * Redis cache keys). SHA-256 without a salt or a slow KDF is correct
 * *here* — unlike a password, the input is 256 bits of randomness, so
 * there's nothing to brute-force or precompute a dictionary for; the
 * hash exists purely so a leaked database/cache dump can't be replayed
 * as credentials.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison for secrets/MACs (never use === on these). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmacHex(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}
