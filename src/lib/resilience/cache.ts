/**
 * Fail-soft Redis cache behind a circuit breaker. Redis is never the source of truth
 * (Postgres is), so every operation here degrades to "cache miss / no-op" rather than
 * an error — a Redis outage makes the API slower, not broken.
 */
import type { Redis } from 'ioredis';
import { createBreaker } from './circuit.js';

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Run an arbitrary Redis operation through the breaker; resolves `fallback` instead of throwing. */
  run<T>(fn: (r: Redis) => Promise<T>, fallback: T): Promise<T>;
}

export function makeCache(redis: Redis): Cache {
  const exec = createBreaker('redis', (fn: (r: Redis) => Promise<unknown>) => fn(redis), { timeoutMs: 750, volumeThreshold: 3 });

  async function run<T>(fn: (r: Redis) => Promise<T>, fallback: T): Promise<T> {
    try { return (await exec(fn)) as T; } catch { return fallback; }
  }
  return {
    run,
    get: (key) => run((r) => r.get(key), null),
    set: (key, value, ttl) => run((r) => r.set(key, value, 'EX', ttl).then(() => undefined), undefined),
    del: async (...keys) => { if (keys.length) await run((r) => r.del(...keys).then(() => undefined), undefined); },
  };
}
