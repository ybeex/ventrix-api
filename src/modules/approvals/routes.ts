import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid, emptyBodyOk, lits } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import { hydrateTx } from '../transactions/service.js';
import { TxView } from '../transactions/views.js';
import * as svc from './service.js';

export const ApprovalView = Obj({
  id: Uuid, operation: lits(['adjustment', 'loss', 'retirement', 'checkout', 'checkout_batch', 'checkin']), status: lits(['pending', 'approved', 'rejected', 'cancelled']),
  item: Nullable(Obj({ id: Uuid, name: Type.String(), itemNumber: Type.String() })), request: Type.Any(),
  requestedBy: Obj({ id: Uuid, name: Nullable(Type.String()) }), reviewedBy: Nullable(Obj({ id: Uuid, name: Nullable(Type.String()) })),
  reviewedAt: Nullable(IsoDate), reviewNote: Nullable(Type.String()), resultingTransactionId: Nullable(Uuid), createdAt: IsoDate,
});

export default async function approvalRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const one = async (req: { user?: { orgId: string } }, a: Parameters<typeof svc.hydrateApproval>[2]) => svc.hydrateApproval(app.db, req.user!.orgId, a);

  app.get('/approvals', {
    config: { permission: 'approvals:read' },
    schema: { querystring: Obj({ ...PageQuery, status: Type.Optional(lits(['pending', 'approved', 'rejected', 'cancelled'])), operation: Type.Optional(lits(['adjustment', 'loss', 'retirement', 'checkout', 'checkout_batch', 'checkin'])) }), response: { 200: PageOf(ApprovalView) } },
  }, async (req) => svc.listApprovals(app.db, actorOf(req), { ...req.query, limit: req.query.limit ?? 25 }));

  app.get('/approvals/:id', { config: { permission: 'approvals:read' }, schema: { params: IdParams, response: { 200: ApprovalView } } },
    async (req) => svc.getApproval(app.db, actorOf(req), req.params.id));

  app.post('/approvals/:id/approve', {
    config: { permission: 'approvals:review' }, preValidation: emptyBodyOk,
    schema: { params: IdParams, body: Obj({ note: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) }), response: { 200: Obj({ approval: ApprovalView, transactions: Type.Array(TxView) }) } },
  }, async (req) => {
    const { approval, rows } = await svc.approve(app.db, actorOf(req), req.params.id, req.body.note);
    return { approval: await one(req, approval), transactions: await hydrateTx(app.db, req.user!.orgId, rows) };
  });

  app.post('/approvals/:id/reject', {
    config: { permission: 'approvals:review' },
    schema: { params: IdParams, body: Obj({ note: Type.String({ minLength: 1, maxLength: 1000 }) }), response: { 200: ApprovalView } },
  }, async (req) => one(req, await svc.reject(app.db, actorOf(req), req.params.id, req.body.note)));

  app.post('/approvals/:id/cancel', { config: { permission: 'approvals:read' }, schema: { params: IdParams, response: { 200: ApprovalView } } },
    async (req) => one(req, await svc.cancel(app.db, actorOf(req), req.params.id)));
}
