/**
 * Circuit breakers for every dependency that is not Postgres: outbound email
 * (Mailgun over SMTP), object storage (S3-compatible) and the Redis cache.
 *
 * Why: when a dependency is slow or down, naive code keeps sending it work and
 * every request that touches it holds a connection/worker until its own timeout —
 * one flaky provider becomes a full outage. A breaker measures the failure rate,
 * and once it crosses the threshold it *opens*: calls fail instantly (503
 * DEPENDENCY_UNAVAILABLE, or a defined fallback) without touching the dependency,
 * then periodically lets one probe through (half-open) to detect recovery.
 *
 * What each breaker's open-state means in this system is deliberate, per dependency:
 *   mail     → emails stay in the outbox (status pending) and are retried with backoff;
 *              nothing is lost and no request ever blocks on SMTP.
 *   storage  → upload/download endpoints return 503 immediately; everything else works.
 *   redis    → reads fall back to Postgres (sessions) / are skipped (settings cache);
 *              rate limiting fails open. Postgres stays the source of truth.
 */
import CircuitBreaker from 'opossum';
import { env } from '../../env.js';
import { DependencyUnavailableError } from '../errors.js';
import { metrics } from '../metrics.js';

const breakers = new Map<string, CircuitBreaker<unknown[], unknown>>();

export interface BreakerOptions {
  timeoutMs?: number;
  /** Errors for which this returns true are the caller's fault (bad input, 404 object) — they must not trip the breaker. */
  ignoreError?: (err: unknown) => boolean;
  errorThresholdPercentage?: number;
  resetTimeoutMs?: number;
  volumeThreshold?: number;
}

export function createBreaker<A extends unknown[], R>(
  name: string,
  action: (...args: A) => Promise<R>,
  opts: BreakerOptions = {},
): (...args: A) => Promise<R> {
  const breaker = new CircuitBreaker(action as (...args: unknown[]) => Promise<unknown>, {
    name,
    timeout: opts.timeoutMs ?? env.CB_TIMEOUT_MS,
    errorThresholdPercentage: opts.errorThresholdPercentage ?? env.CB_ERROR_THRESHOLD_PCT,
    resetTimeout: opts.resetTimeoutMs ?? env.CB_RESET_TIMEOUT_MS,
    volumeThreshold: opts.volumeThreshold ?? env.CB_VOLUME_THRESHOLD, // don't trip on the first failure of a quiet dependency
    rollingCountTimeout: 10_000,
    rollingCountBuckets: 10,
    errorFilter: opts.ignoreError,
  });

  const ev = (event: string) => metrics.breakerEvents.inc({ name, event });
  metrics.breakerState.set({ name }, 0);
  breaker.on('open', () => { metrics.breakerState.set({ name }, 2); ev('open'); });
  breaker.on('halfOpen', () => { metrics.breakerState.set({ name }, 1); ev('half_open'); });
  breaker.on('close', () => { metrics.breakerState.set({ name }, 0); ev('close'); });
  breaker.on('reject', () => ev('reject'));
  breaker.on('timeout', () => ev('timeout'));
  breaker.on('failure', () => ev('failure'));

  breakers.set(name, breaker);

  return async (...args: A) => {
    try {
      return (await breaker.fire(...args)) as R;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'EOPENBREAKER' || code === 'ETIMEDOUT') throw new DependencyUnavailableError(name);
      throw err; // a real error from the dependency (or ignored caller error) passes through untouched
    }
  };
}

export type BreakerState = 'closed' | 'half-open' | 'open';

export function breakerStates(): Record<string, BreakerState> {
  const out: Record<string, BreakerState> = {};
  for (const [name, b] of breakers) out[name] = b.opened ? 'open' : b.halfOpen ? 'half-open' : 'closed';
  return out;
}

/** Test hook / ops hook: force a breaker open or closed. */
export function setBreaker(name: string, state: 'open' | 'closed'): void {
  const b = breakers.get(name);
  if (!b) throw new Error(`Unknown breaker ${name}`);
  if (state === 'open') b.open(); else b.close();
}

export function shutdownBreakers(): void {
  for (const b of breakers.values()) b.shutdown();
  breakers.clear();
}
