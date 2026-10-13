import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { actorOf } from '../../lib/actor.js';
import { IdParams, IsoDate, Nullable, Obj, PageQuery, Uuid, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import { ItemView } from '../items/routes.js';
import { serializeItem } from '../items/queries.js';
import { View as HolderView, ser as serHolder } from '../holders/routes.js';
import { getSettings } from '../organization/settings.service.js';
import * as svc from './service.js';

const ClientId = Type.String({ minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' });
const DeviceId = Type.String({ minLength: 4, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' });
const Outcome = Obj({
  clientGeneratedId: Type.String(), status: lits(['applied', 'duplicate', 'pending_approval', 'conflict', 'rejected']),
  transactionId: Type.Optional(Uuid), approvalId: Type.Optional(Uuid), issueId: Type.Optional(Uuid), code: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
});
const IssueView = Obj({
  id: Uuid, kind: lits(['conflict', 'rejected']), status: lits(['open', 'resolved_kept_server', 'resolved_applied_client']), deviceId: Type.String(),
  actor: Obj({ id: Uuid, name: Nullable(Type.String()) }), clientGeneratedId: Type.String(), operation: Type.String(), itemId: Nullable(Uuid), payload: Type.Any(),
  code: Type.String(), message: Type.String(), detectedAt: IsoDate, resolvedAt: Nullable(IsoDate), resolvedBy: Nullable(Uuid), resolutionNote: Nullable(Type.String()), resultingTransactionId: Nullable(Uuid),
});
const Delta = { cursor: Type.Optional(Type.String({ maxLength: 300 })), since: Type.Optional(IsoDate), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 200 })) };

export default async function syncRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.post('/sync/batch', {
    config: { permission: 'sync:push' },
    schema: {
      body: Obj({ deviceId: DeviceId, actions: Type.Array(Obj({ clientGeneratedId: ClientId, type: Type.String({ maxLength: 30 }), queuedAt: IsoDate, payload: Type.Any() }), { minItems: 1, maxItems: 100 }) }),
      response: { 200: Obj({ results: Type.Array(Outcome), serverTime: IsoDate }) },
    },
  }, async (req) => ({ results: await svc.processBatch(app.db, { ...actorOf(req), deviceId: req.body.deviceId }, req.body.deviceId, req.body.actions) as never, serverTime: new Date().toISOString() }));

  app.get('/sync/conflicts', {
    config: { permission: 'sync:resolve' },
    schema: { querystring: Obj({ ...PageQuery, status: Type.Optional(lits(['open', 'resolved'])) }), response: { 200: Obj({ items: Type.Array(IssueView), nextCursor: Nullable(Type.String()) }) } },
  }, async (req) => svc.listIssues(app.db, req.user!.orgId, { status: req.query.status ?? 'open', cursor: req.query.cursor, limit: req.query.limit ?? 25 }));

  app.post('/sync/conflicts/:id/resolve', {
    config: { permission: 'sync:resolve' },
    schema: { params: IdParams, body: Obj({ resolution: lits(['keep_server', 'apply_client']), note: Type.String({ minLength: 1, maxLength: 1000 }) }), response: { 200: IssueView } },
  }, async (req) => svc.resolveIssue(app.db, actorOf(req), req.params.id, req.body));

  app.get('/sync/snapshot/items', {
    config: { permission: 'sync:read' },
    schema: { querystring: Obj(Delta), response: { 200: Obj({ items: Type.Array(ItemView), cursor: Nullable(Type.String()), hasMore: Type.Boolean(), serverTime: IsoDate }) } },
  }, async (req) => {
    const d = await svc.itemDelta(app.db, req.user!.orgId, { cursor: req.query.cursor, since: req.query.since, limit: req.query.limit ?? 200 });
    const hours = await getSettings(app.db, req.user!.orgId, app.cache);
    return { items: d.rows.map((r) => serializeItem(r, hours)), cursor: d.cursor, hasMore: d.hasMore, serverTime: new Date().toISOString() };
  });

  app.get('/sync/snapshot/holders', {
    config: { permission: 'sync:read' },
    schema: { querystring: Obj(Delta), response: { 200: Obj({ items: Type.Array(HolderView), cursor: Nullable(Type.String()), hasMore: Type.Boolean(), serverTime: IsoDate }) } },
  }, async (req) => {
    const d = await svc.holderDelta(app.db, req.user!.orgId, { cursor: req.query.cursor, since: req.query.since, limit: req.query.limit ?? 200 });
    return { items: d.rows.map(serHolder), cursor: d.cursor, hasMore: d.hasMore, serverTime: new Date().toISOString() };
  });

  app.get('/sync/snapshot/reference', {
    config: { permission: 'sync:read' },
    schema: { response: { 200: Type.Any() } },
  }, async (req) => ({ ...(await svc.referenceData(app.db, req.user!.orgId)), serverTime: new Date().toISOString() }));
}
