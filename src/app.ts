import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { env } from './env.js';
import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import securityPlugin from './plugins/security.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import observabilityPlugin from './plugins/observability.js';
import authPlugin from './plugins/auth.js';
import accessPlugin from './plugins/access.js';
import idempotencyPlugin from './plugins/idempotency.js';
import { registerModules } from './modules/index.js';
import { bodyAjv, requestAjv } from './lib/ajv.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Credentials and secrets must never reach logs.
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1_048_576, // 1 MiB for JSON; uploads use multipart with their own, tighter cap
    requestTimeout: 30_000,
    keepAliveTimeout: 65_000, // longer than typical load-balancer idle timeouts, so the LB never reuses a socket we closed
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Validation is part-aware ON PURPOSE.
  //  - JSON BODIES: no type coercion. JSON already has exact types, and coercion is actively dangerous there:
  //    Ajv would turn `null` into `0` / `false` / "" — e.g. { "largeAdjustmentThreshold": null } silently became 0
  //    and made every adjustment require approval. A body must match its schema exactly or it is a 400.
  //  - QUERY / PARAMS / HEADERS arrive as strings, so they ARE coerced ("limit=10" → 10, "true" → true).
  //  - Unknown fields are a 400, never silently dropped (mass-assignment defence — see lib/strict.ts).
  // ajv-formats is CommonJS; under NodeNext its callable lives on `.default`.
  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === 'body' ? bodyAjv : requestAjv).compile(schema));

  // JSON-only API: Fastify also accepts text/plain by default. Remove it so any other body type is an explicit 415 (multipart is added by the file/import routes).
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    return payload;
  });

  // Order matters: stores → perimeter → errors → auth/access → idempotency → routes.
  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(securityPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(accessPlugin); // before ANY route is registered (infra routes included), so the registry/fail-closed check sees them all
  await app.register(observabilityPlugin);
  await app.register(idempotencyPlugin);

  if (env.NODE_ENV !== 'production') {
    // API docs are a development aid. They are dev-only DEPENDENCIES loaded dynamically, so the production image
    // (npm ci --omit=dev) does not even contain the swagger UI / static file server — nothing to attack.
    const [{ default: swagger }, { default: swaggerUi }] = await Promise.all([import('@fastify/swagger'), import('@fastify/swagger-ui')]);
    await app.register(swagger, {
      openapi: {
        info: { title: 'StoreKeeper API', version: '1.0.0', description: 'Transaction & accountability backend (PRD v3)' },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
        security: [{ bearer: [] }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await registerModules(app);
  return app;
}
