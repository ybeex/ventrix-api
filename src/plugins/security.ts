/**
 * Perimeter security and overload protection, registered before auth so every route inherits it.
 *
 *  - HTTPS: with FORCE_HTTPS the API refuses plain-HTTP requests (as seen via X-Forwarded-Proto
 *    from the TLS terminator) and sends HSTS. PRD §37: "HTTPS everywhere".
 *  - Responses are `Cache-Control: no-store` by default — inventory/accountability data must not
 *    linger in shared-tablet browser caches or intermediaries.
 *  - CORS is allowlist-only and fails closed when unconfigured.
 *  - Rate limiting is Redis-backed (N stateless instances share one budget) and fails open.
 *  - Load shedding returns an honest 503 + Retry-After instead of slowing every request.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import { env } from '../env.js';
import { TooManyRequestsError, AppError } from '../lib/errors.js';

/** One bucket per session token, else per IP (warehouse NAT would otherwise throttle a whole site as one client). */
function rateLimitKey(req: { headers: Record<string, unknown>; ip: string }): string {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.length > 0
    ? `tok:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`
    : `ip:${req.ip}`;
}

export default fp(async function securityPlugin(app: FastifyInstance) {
  if (env.FORCE_HTTPS) {
    app.addHook('onRequest', async (req) => {
      if (req.url === '/healthz' || req.url === '/readyz') return; // load-balancer probes are plain HTTP inside the VPC
      const proto = req.headers['x-forwarded-proto'];
      if (proto !== 'https') throw new AppError(426, 'HTTPS_REQUIRED', 'This API is only available over HTTPS');
    });
  }

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins.length ? allowedOrigins : false, // fail closed if unconfigured
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id', 'x-device-id'],
    exposedHeaders: ['idempotent-replayed', 'retry-after', 'x-request-id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    redis: app.redis,
    nameSpace: 'rl:',
    skipOnError: true, // a limiter outage must not become an API outage
    keyGenerator: rateLimitKey,
    errorResponseBuilder: (_req, context) => new TooManyRequestsError(Math.ceil(context.ttl / 1000)),
  });

  if (env.LOAD_SHEDDING) {
    await app.register(underPressure, {
      maxEventLoopDelay: 1000,
      maxHeapUsedBytes: 1_500_000_000,
      maxRssBytes: 2_000_000_000,
      retryAfter: 50,
    });
  }
});

/** Per-route limit for credential endpoints (login, PIN, invite acceptance, password reset): tight and always IP-keyed. */
export const authRouteRateLimit = {
  rateLimit: {
    max: env.AUTH_RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req: { ip: string }) => `ip:${req.ip}`,
  },
};
