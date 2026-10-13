import { createHash } from 'node:crypto';

/** JSON with recursively sorted keys, so semantically-equal bodies hash identically regardless of key order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function fingerprintOf(...parts: unknown[]): string {
  return createHash('sha256').update(parts.map(canonicalize).join('|')).digest('hex');
}
