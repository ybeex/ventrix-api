/**
 * One shared Redis connection + the breaker-wrapped fail-soft cache (lib/resilience/cache.ts).
 * Redis backs: the rate limiter, the session read-cache, the org-settings cache and BullMQ.
 * None of these is a source of truth — Postgres always is — so a Redis outage degrades
 * speed (auth lookups hit the DB, limits reset) instead of correctness.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { env } from '../env.js';
import { makeCache, type Cache } from '../lib/resilience/cache.js';
import { shutdownBreakers } from '../lib/resilience/circuit.js';
import { closeQueues } from '../lib/queue.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    cache: Cache;
  }
}

export default fp(async function redisPlugin(app: FastifyInstance) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false, // fail fast instead of buffering unboundedly during an outage
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });
  redis.on('error', (err) => app.log.error({ err }, 'redis connection error'));

  // Give the first connect a moment so the very first requests don't race the handshake; never block boot on it.
  await new Promise<void>((resolve) => {
    if (redis.status === 'ready') return resolve();
    const t = setTimeout(resolve, 3000);
    redis.once('ready', () => { clearTimeout(t); resolve(); });
  });

  app.decorate('redis', redis);
  app.decorate('cache', makeCache(redis));
  app.addHook('onClose', async () => {
    await closeQueues();
    shutdownBreakers();
    redis.disconnect();
  });
});
