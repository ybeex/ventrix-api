import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import { pendingApprovals } from '../../db/schema.js';
import { actorOf } from '../../lib/actor.js';
import { requireIdempotencyKey } from '../../lib/idempotency-header.js';
import { IdParams, IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid, emptyBodyOk, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import { ApprovalView } from '../approvals/routes.js';
import { hydrateApproval } from '../approvals/service.js';
import { hydrateTx } from '../transactions/service.js';
import { TxView } from '../transactions/views.js';
import * as svc from './service.js';

const Scope = lits(['item', 'category', 'shelf', 'location']);
const Resolution = lits(['matched', 'adjusted', 'pending_approval', 'rejected', 'unresolved']);
const SessionView = Obj({ id: Uuid, scope: Scope, scopeId: Uuid, status: lits(['open', 'closed']), note: Nullable(Type.String()), startedBy: Uuid, startedAt: IsoDate, closedBy: Nullable(Uuid), closedAt: Nullable(IsoDate) });
const CountView = Obj({
  id: Uuid, itemId: Uuid, itemNumber: Type.String(), itemName: Type.String(), systemQuantity: Type.Integer(), physicalQuantity: Type.Integer(), variance: Type.Integer(),
  reason: Nullable(Type.String()), note: Nullable(Type.String()), resolution: Resolution, countedBy: Obj({ id: Uuid, name: Nullable(Type.String()) }),
  ledgerTransactionId: Nullable(Uuid), adjustmentTransactionId: Nullable(Uuid), pendingApprovalId: Nullable(Uuid), createdAt: IsoDate,
});
const ser = (r: Awaited<ReturnType<typeof svc.startReconciliation>>) => ({
  id: r.id, scope: r.scope, scopeId: r.scopeId, status: r.status, note: r.note, startedBy: r.startedBy, startedAt: r.startedAt.toISOString(), closedBy: r.closedBy, closedAt: r.closedAt?.toISOString() ?? null,
});

export default async function reconciliationRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.post('/reconciliations', {
    config: { permission: 'reconciliation:run', idempotent: true },
    schema: { body: Obj({ scope: Scope, scopeId: Uuid, note: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) }), response: { 201: SessionView } },
  }, async (req, reply) => reply.code(201).send(ser(await svc.startReconciliation(app.db, actorOf(req), req.body))));

  app.get('/reconciliations', {
    config: { permission: 'reconciliation:read' },
    schema: { querystring: Obj({ ...PageQuery, status: Type.Optional(lits(['open', 'closed'])) }), response: { 200: PageOf(SessionView) } },
  }, async (req) => { const p = await svc.listReconciliations(app.db, req.user!.orgId, { ...req.query, limit: req.query.limit ?? 25 }); return { items: p.items.map(ser), nextCursor: p.nextCursor }; });

  app.get('/reconciliations/:id', {
    config: { permission: 'reconciliation:read' },
    schema: { params: IdParams, response: { 200: Obj({
      reconciliation: SessionView, counts: Type.Array(CountView),
      summary: Obj({ counted: Type.Integer(), matched: Type.Integer(), discrepancies: Type.Integer(), adjusted: Type.Integer(), pendingApproval: Type.Integer(), unresolved: Type.Integer() }),
    }) } },
  }, async (req) => { const r = await svc.getReconciliation(app.db, req.user!.orgId, req.params.id); return { reconciliation: ser(r.row), counts: r.counts, summary: r.summary }; });

  app.get('/reconciliations/:id/expected', {
    config: { permission: 'reconciliation:read' },
    schema: { params: IdParams, querystring: Obj({ cursor: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }),
      response: { 200: Obj({ items: Type.Array(Obj({ itemId: Uuid, itemNumber: Type.String(), name: Type.String(), type: lits(['asset', 'consumable']), unit: Type.String(), systemQuantity: Type.Integer(), counted: Type.Boolean() })), nextCursor: Nullable(Type.String()) }) } },
  }, async (req) => svc.expectedItems(app.db, req.user!.orgId, req.params.id, { cursor: req.query.cursor, limit: req.query.limit ?? 50 }));

  app.post('/reconciliations/:id/counts', {
    config: { permission: 'reconciliation:run' },
    schema: {
      params: IdParams,
      body: Obj({ itemId: Uuid, physicalQuantity: Type.Integer({ minimum: 0, maximum: 10_000_000 }), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), note: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })), snapshotFileId: Type.Optional(Uuid), adjust: Type.Optional(Type.Boolean()) }),
      response: { 200: Obj({ count: CountView, transactions: Type.Array(TxView), approval: Nullable(ApprovalView) }), 201: Obj({ count: CountView, transactions: Type.Array(TxView), approval: Nullable(ApprovalView) }) },
    },
  }, async (req, reply) => {
    const r = await svc.recordCount(app.db, actorOf(req), req.params.id, requireIdempotencyKey(req.headers), req.body);
    if (r.status !== 'committed') throw new Error('unreachable: counts are never deferred');
    if (r.replayed) reply.header('idempotent-replayed', 'true');
    const count = await svc.countForLedger(app.db, req.user!.orgId, r.primary.id);
    const approval = count.pendingApprovalId ? await app.db.select().from(pendingApprovals).where(eq(pendingApprovals.id, count.pendingApprovalId)).then((a) => hydrateApproval(app.db, req.user!.orgId, a[0])) : null;
    return reply.code(r.replayed ? 200 : 201).send({ count, transactions: await hydrateTx(app.db, req.user!.orgId, r.rows), approval });
  });

  app.post('/reconciliations/:id/close', {
    config: { permission: 'reconciliation:run' }, preValidation: emptyBodyOk,
    schema: { params: IdParams, body: Obj({ note: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) }), response: { 200: SessionView } },
  }, async (req) => ser(await svc.closeReconciliation(app.db, actorOf(req), req.params.id, req.body.note)));
}
