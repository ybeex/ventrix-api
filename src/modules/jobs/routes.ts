import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

const Status = Type.Union([Type.Literal('active'), Type.Literal('closed')]);
const View = Obj({ id: Uuid, code: Nullable(Type.String()), name: Type.String(), status: Status, archivedAt: Nullable(IsoDate), createdAt: IsoDate });
const ser = (j: svc.JobRow) => ({ id: j.id, code: j.code, name: j.name, status: j.status, archivedAt: j.archivedAt?.toISOString() ?? null, createdAt: j.createdAt.toISOString() });

export default async function jobRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  app.get('/jobs', {
    config: { permission: 'jobs:read' },
    schema: { querystring: Obj({ ...PageQuery, q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), status: Type.Optional(Status), includeArchived: Type.Optional(Type.Boolean()) }), response: { 200: PageOf(View) } },
  }, async (req) => { const p = await svc.listJobs(app.db, req.user!.orgId, { ...req.query, limit: req.query.limit ?? 25 }); return { items: p.items.map(ser), nextCursor: p.nextCursor }; });
  app.post('/jobs', {
    config: { permission: 'jobs:manage' },
    schema: { body: Obj({ name: Type.String({ minLength: 1, maxLength: 160 }), code: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })) }), response: { 201: View } },
  }, async (req, reply) => reply.code(201).send(ser(await svc.createJob(app.db, actorOf(req), req.body))));
  app.patch('/jobs/:id', {
    config: { permission: 'jobs:manage' },
    schema: { params: IdParams, body: Obj({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), code: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 40 }))), status: Type.Optional(Status) }, { minProperties: 1 }), response: { 200: View } },
  }, async (req) => ser(await svc.updateJob(app.db, actorOf(req), req.params.id, req.body)));
  app.post('/jobs/:id/archive', { config: { permission: 'jobs:manage' }, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.archiveJob(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });
}
