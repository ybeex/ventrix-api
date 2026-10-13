/**
 * argon2id — the current OWASP recommendation for new systems, and
 * deliberately memory-hard (unlike bcrypt) to stay expensive against
 * GPU/ASIC cracking attempts even as hardware improves. Parameters
 * below follow OWASP's 2024 minimums; re-check that guidance
 * periodically rather than treating these as permanent.
 */
import argon2 from 'argon2';

const HASH_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTS);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}
