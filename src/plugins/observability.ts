/**
 * Health, readiness and metrics.
 *  /healthz  liveness — process is up (no dependencies touched, so a DB blip never restarts healthy pods).
 *  /readyz   readiness — can this instance serve traffic? Postgres is required; Redis and the circuit
 *            breakers are reported (Redis is fail-soft, so it degrades rather than fails readiness).
 *  /metrics  Prometheus; bearer-token protected (METRICS_TOKEN is mandatory in production).
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { pingDb } from '../db/index.js';
import { metrics, registry } from '../lib/metrics.js';
import { breakerStates } from '../lib/resilience/circuit.js';
import { safeEqual } from '../lib/tokens.js';
import { UnauthorizedError } from '../lib/errors.js';

export default fp(async function observabilityPlugin(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url;
    if (!route) return; // unmatched routes would create unbounded label cardinality
    metrics.httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  const livenessSchema = {
    response: {
      200: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: { status: { type: 'string', enum: ['ok'] } },
      },
    },
  } as const;
  const livenessHandler = async () => ({ status: 'ok' as const });
  const livenessOptions = { schema: livenessSchema, config: { public: true, rateLimit: false }, logLevel: 'warn' as const };

  // Keep conventional probe paths alongside /healthz for existing deployments.
  app.get('/health', livenessOptions, livenessHandler);
  app.get('/live', livenessOptions, livenessHandler);
  app.get('/healthz', livenessOptions, livenessHandler);

  const readinessSchema = {
    response: {
      200: {
        type: 'object', additionalProperties: false, required: ['status', 'db', 'redis', 'breakers'],
        properties: {
          status: { type: 'string', enum: ['ready', 'degraded'] },
          db: { type: 'boolean' }, redis: { type: 'boolean' },
          breakers: { type: 'object', additionalProperties: { type: 'string', enum: ['closed', 'half-open', 'open'] } },
        },
      },
      503: {
        type: 'object', additionalProperties: false, required: ['status', 'db', 'redis', 'breakers'],
        properties: {
          status: { type: 'string', enum: ['unavailable'] },
          db: { type: 'boolean' }, redis: { type: 'boolean' },
          breakers: { type: 'object', additionalProperties: { type: 'string', enum: ['closed', 'half-open', 'open'] } },
        },
      },
    },
  } as const;
  app.get('/readyz', { schema: readinessSchema, config: { public: true, rateLimit: false }, logLevel: 'warn' }, async (_req, reply) => {
    let db = true;
    let redis = true;
    try { await pingDb(); } catch { db = false; }
    try { await app.redis.ping(); } catch { redis = false; }
    const body = { status: db ? (redis ? 'ready' : 'degraded') : 'unavailable', db, redis, breakers: breakerStates() };
    return reply.code(db ? 200 : 503).send(body);
  });

  app.get('/metrics', { config: { public: true, rateLimit: false }, logLevel: 'warn' }, async (req, reply) => {
    if (env.METRICS_TOKEN) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), env.METRICS_TOKEN)) throw new UnauthorizedError();
    } else if (env.NODE_ENV === 'production') {
      throw new UnauthorizedError();
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
});
