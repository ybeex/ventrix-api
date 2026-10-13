import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid, lits } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

const Type_ = lits(['low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending', 'approval_decided', 'announcement', 'cycle_count_due']);
const View = Obj({ id: Uuid, type: Type_, title: Type.String(), body: Type.String(), entityType: Nullable(Type.String()), entityId: Nullable(Type.String()), read: Type.Boolean(), createdAt: IsoDate });
const ser = (n: Awaited<ReturnType<typeof svc.listNotifications>>['items'][number]) => ({ id: n.id, type: n.type, title: n.title, body: n.body, entityType: n.entityType, entityId: n.entityId, read: n.readAt !== null, createdAt: n.createdAt.toISOString() });

export default async function notificationRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const own = { permission: 'notifications:own' } as const;

  app.get('/notifications', {
    config: own,
    schema: { querystring: Obj({ ...PageQuery, unread: Type.Optional(Type.Boolean()) }), response: { 200: PageOf(View) } },
  }, async (req) => { const p = await svc.listNotifications(app.db, req.user!.id, { unreadOnly: req.query.unread, cursor: req.query.cursor, limit: req.query.limit ?? 25 }); return { items: p.items.map(ser), nextCursor: p.nextCursor }; });

  app.get('/notifications/unread-count', { config: own, schema: { response: { 200: Obj({ count: Type.Integer() }) } } },
    async (req) => ({ count: await svc.unreadCount(app.db, req.user!.id) }));

  app.post('/notifications/read-all', { config: own, schema: { response: { 200: Obj({ marked: Type.Integer() }) } } },
    async (req) => ({ marked: await svc.markAllRead(app.db, req.user!.id) }));

  app.post('/notifications/:id/read', { config: own, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.markRead(app.db, req.user!.id, req.params.id); return reply.code(204).send(null); });

  app.get('/notifications/preferences', {
    config: own,
    schema: { response: { 200: Obj({ items: Type.Array(Obj({ type: Type_, inApp: Type.Boolean(), email: Type.Boolean(), emailIsOrgDefault: Type.Boolean() })) }) } },
  }, async (req) => ({ items: await svc.getPreferences(app.db, req.user!.id, req.user!.orgId) }));

  app.put('/notifications/preferences/:type', {
    config: own,
    schema: { params: Obj({ type: Type_ }), body: Obj({ inApp: Type.Optional(Type.Boolean()), email: Type.Optional(Nullable(Type.Boolean())) }, { minProperties: 1 }), response: { 204: Type.Null() } },
  }, async (req, reply) => { await svc.setPreference(app.db, actorOf(req), req.params.type, req.body); return reply.code(204).send(null); });
}
