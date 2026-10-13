import { UnprocessableError } from '../../lib/errors.js';

const COMMON = new Set(['password1234', 'passwordpassword', '123456789012', 'qwertyuiop12', 'storekeeper123', 'iloveyou1234', 'administrator']);

/** Length is enforced by the schema (12–128). This adds the cheap checks that stop the worst choices. */
export function assertPasswordAcceptable(password: string, email?: string): void {
  const lower = password.toLowerCase();
  const local = email?.split('@')[0]?.toLowerCase();
  const weak =
    COMMON.has(lower) ||
    /^(.)\1+$/.test(password) ||
    (local && local.length >= 4 && lower.includes(local));
  if (weak) throw new UnprocessableError('WEAK_PASSWORD', 'Choose a less guessable password (avoid common phrases, repeated characters, or your email name)');
}

/** PINs are a convenience for shared devices, not a primary credential: 4–8 digits, no trivial patterns. */
export function assertPinAcceptable(pin: string): void {
  const digits = [...pin].map(Number);
  const allSame = digits.every((d) => d === digits[0]);
  const step = (dir: 1 | -1) => digits.every((d, i) => i === 0 || d === digits[i - 1] + dir);
  if (allSame || step(1) || step(-1)) throw new UnprocessableError('WEAK_PIN', 'Choose a PIN that is not a repeated or sequential pattern');
}
