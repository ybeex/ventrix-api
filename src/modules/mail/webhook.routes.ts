/**
 * POST /v1/webhooks/mailgun — bounce / complaint / unsubscribe events from Mailgun.
 *
 * Public (Mailgun has no bearer token) but authenticated by an HMAC signature over timestamp+token with the
 * HTTP webhook signing key, a 5-minute freshness window and a one-time-token replay guard. Always answers 200 to a
 * validly signed event (Mailgun retries on anything else), including for events we deliberately ignore.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { env } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { metrics } from '../../lib/metrics.js';
import { Obj } from '../../lib/strict.js';
import { typed } from '../../types.js';
import { suppress, verifyMailgunSignature, type SuppressionReason } from './suppression.js';

const Body = Type.Object({
  signature: Obj({ timestamp: Type.String({ maxLength: 20 }), token: Type.String({ minLength: 8, maxLength: 200 }), signature: Type.String({ minLength: 16, maxLength: 200 }) }),
  'event-data': Type.Object({
    event: Type.String({ maxLength: 40 }), recipient: Type.String({ minLength: 3, maxLength: 320 }),
    severity: Type.Optional(Type.String({ maxLength: 20 })), id: Type.Optional(Type.String({ maxLength: 200 })),
    'delivery-status': Type.Optional(Type.Object({ message: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }, { additionalProperties: true })),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

export default async function mailWebhookRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  app.post('/webhooks/mailgun', {
    config: { public: true },
    schema: { body: Body, response: { 200: Obj({ status: Type.String() }) } },
  }, async (req) => {
    const { signature, 'event-data': ev } = req.body;
    if (!verifyMailgunSignature(env.MAILGUN_WEBHOOK_SIGNING_KEY, signature)) throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    // One-time token: a captured request cannot be replayed inside the freshness window. Fails open if Redis is down (the signature + window still hold).
    try { if ((await app.redis.set(`mg-webhook:${signature.token}`, '1', 'EX', 900, 'NX')) !== 'OK') return { status: 'duplicate' }; } catch { /* fail open */ }

    const reason: SuppressionReason | null = ev.event === 'complained' ? 'complaint' : ev.event === 'unsubscribed' ? 'unsubscribe'
      : ev.event === 'failed' && ev.severity === 'permanent' ? 'bounce' : null; // temporary failures are Mailgun's to retry
    if (!reason) return { status: 'ignored' };
    const detail = ev['delivery-status']?.message ?? ev['delivery-status']?.description;
    const cancelled = await suppress(app.db, { email: ev.recipient, reason, eventId: ev.id, detail });
    metrics.emailSuppressions.inc({ reason });
    req.log.warn({ reason, cancelledQueued: cancelled, eventId: ev.id }, 'recipient suppressed by provider event');
    return { status: 'suppressed' };
  });
}
