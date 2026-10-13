import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Obj, PageOf, PageQuery, Uuid, lits } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { requireIdempotencyKey } from '../../lib/idempotency-header.js';
import { typed } from '../../types.js';
import { ApprovalView } from '../approvals/routes.js';
import { hydrateApproval } from '../approvals/service.js';
import type { OpResult } from './engine.js';
import { checkin } from './ops/checkin.js';
import { checkout, checkoutBatch } from './ops/checkout.js';
import { correct } from './ops/correct.js';
import { adjust, reportDamage, reportLoss, updateCondition } from './ops/incidents.js';
import { consume, restock } from './ops/stock.js';
import { getTransaction, hydrateTx, listTransactions } from './service.js';
import { ConditionSchema, ReasonSchema, TxType, TxView } from './views.js';
import { AdjustBody, BatchCheckoutBody, CheckinBody, CheckoutBody, ConditionBody, ConsumeBody, IncidentBody, Note, Qty, RestockBody } from './schemas.js';

const Committed = Obj({ status: Type.Literal('committed'), transaction: TxView, transactions: Type.Array(TxView) });
const Pending = Obj({ status: Type.Literal('pending_approval'), approval: ApprovalView });
const responses = { 200: Committed, 201: Committed, 202: Pending };

const Short = (n: number) => Type.String({ minLength: 1, maxLength: n });

export default async function transactionRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  /** One response shape for every operation: 201 new, 200 replay (Idempotent-Replayed: true), 202 awaiting approval. */
  async function respond(reply: FastifyReply, orgId: string, r: OpResult) {
    if (r.replayed) reply.header('idempotent-replayed', 'true');
    if (r.status === 'pending_approval') return reply.code(202).send({ status: 'pending_approval', approval: await hydrateApproval(app.db, orgId, r.approval) });
    const byId = new Map((await hydrateTx(app.db, orgId, r.rows)).map((t) => [t.id, t]));
    const hydrated = r.rows.map((row) => byId.get(row.id)!); // keep the operation's own order (batch: request order)
    const primary = byId.get(r.primary.id) ?? hydrated[0];
    return reply.code(r.replayed ? 200 : 201).send({ status: 'committed', transaction: primary, transactions: hydrated });
  }

  const issue = { permission: 'tx:issue' } as const;
  const adjustPerm = { permission: 'tx:adjust' } as const;

  app.post('/transactions/checkout', {
    config: issue,
    schema: {
      body: CheckoutBody,
      response: responses,
    },
  }, async (req, reply) => respond(reply, req.user!.orgId, await checkout(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/checkout/batch', {
    config: issue,
    schema: {
      body: BatchCheckoutBody,
      response: responses,
    },
  }, async (req, reply) => respond(reply, req.user!.orgId, await checkoutBatch(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/checkin', {
    config: issue,
    schema: {
      body: CheckinBody,
      response: responses,
    },
  }, async (req, reply) => respond(reply, req.user!.orgId, await checkin(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/consume', {
    config: issue,
    schema: { body: ConsumeBody, response: responses },
  }, async (req, reply) => respond(reply, req.user!.orgId, await consume(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/restock', {
    config: issue,
    schema: { body: RestockBody, response: responses },
  }, async (req, reply) => respond(reply, req.user!.orgId, await restock(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/adjust', {
    config: adjustPerm,
    schema: { body: AdjustBody, response: responses },
  }, async (req, reply) => respond(reply, req.user!.orgId, await adjust(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/loss', { config: adjustPerm, schema: { body: IncidentBody, response: responses } },
    async (req, reply) => respond(reply, req.user!.orgId, await reportLoss(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));
  app.post('/transactions/damage', { config: adjustPerm, schema: { body: IncidentBody, response: responses } },
    async (req, reply) => respond(reply, req.user!.orgId, await reportDamage(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/condition', {
    config: adjustPerm,
    schema: { body: ConditionBody, response: responses },
  }, async (req, reply) => respond(reply, req.user!.orgId, await updateCondition(app.db, actorOf(req), requireIdempotencyKey(req.headers), req.body)));

  app.post('/transactions/:id/correct', {
    config: { permission: 'tx:correct' },
    schema: {
      params: IdParams,
      body: Obj({
        note: Note,
        replacement: Type.Optional(Obj({
          itemId: Type.Optional(Uuid), holderId: Type.Optional(Uuid), quantity: Type.Optional(Qty), jobId: Type.Optional(Uuid), purpose: Type.Optional(Short(300)), dueAt: Type.Optional(IsoDate),
          quantityDelta: Type.Optional(Type.Integer({ minimum: -10_000_000, maximum: 10_000_000 })), reason: Type.Optional(ReasonSchema), condition: Type.Optional(ConditionSchema),
          toState: Type.Optional(lits(['available', 'damaged', 'under_repair', 'retired'])),
        })),
      }),
      response: responses,
    },
  }, async (req, reply) => respond(reply, req.user!.orgId, await correct(app.db, actorOf(req), requireIdempotencyKey(req.headers), { transactionId: req.params.id, ...req.body })));

  app.get('/transactions', {
    config: { permission: 'tx:read' },
    schema: {
      querystring: Obj({ ...PageQuery, itemId: Type.Optional(Uuid), type: Type.Optional(TxType), holderId: Type.Optional(Uuid), actorId: Type.Optional(Uuid), jobId: Type.Optional(Uuid), from: Type.Optional(IsoDate), to: Type.Optional(IsoDate) }),
      response: { 200: PageOf(TxView) },
    },
  }, async (req) => {
    const { from, to, limit, ...rest } = req.query;
    return listTransactions(app.db, req.user!.orgId, { ...rest, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, limit: limit ?? 25 });
  });

  app.get('/transactions/:id', { config: { permission: 'tx:read' }, schema: { params: IdParams, response: { 200: TxView } } },
    async (req) => getTransaction(app.db, req.user!.orgId, req.params.id));
}
