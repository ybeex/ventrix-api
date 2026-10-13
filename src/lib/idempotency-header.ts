import { ValidationError } from './errors.js';

/** Same bounds as plugins/idempotency.ts so the client contract ("send an 8–200 char Idempotency-Key on any mutating request") is uniform. */
export function requireIdempotencyKey(headers: Record<string, unknown>): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new ValidationError('An Idempotency-Key header (8-200 characters) is required for this endpoint');
  }
  return key;
}
