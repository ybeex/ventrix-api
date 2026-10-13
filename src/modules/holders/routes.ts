import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid, lits } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

const Kind = lits(['person', 'team', 'department', 'job_site', 'other']);
export const View = Obj({ id: Uuid, kind: Kind, name: Type.String(), code: Nullable(Type.String()), userId: Nullable(Uuid), jobId: Nullable(Uuid), archivedAt: Nullable(IsoDate), createdAt: IsoDate });
export const ser = (h: svc.HolderRow) => ({ id: h.id, kind: h.kind, name: h.name, code: h.code, userId: h.userId, jobId: h.jobId, archivedAt: h.archivedAt?.toISOString() ?? null, createdAt: h.createdAt.toISOString() });

export default async function holderRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.get('/holders/recent', {
    config: { permission: 'holders:read' },
    schema: { querystring: Obj({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })) }), response: { 200: Obj({ items: Type.Array(Obj({ id: Uuid, kind: Kind, name: Type.String(), lastUsedAt: IsoDate })) }) } },
  }, async (req) => ({ items: (await svc.recentHolders(app.db, actorOf(req), req.query.limit ?? 8)).map((r) => ({ ...r, lastUsedAt: new Date(r.lastUsedAt).toISOString() })) }));

  app.get('/holders', {
    config: { permission: 'holders:read' },
    schema: { querystring: Obj({ ...PageQuery, q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), kind: Type.Optional(Kind), includeArchived: Type.Optional(Type.Boolean()) }), response: { 200: PageOf(View) } },
  }, async (req) => {
    const p = await svc.listHolders(app.db, req.user!.orgId, { ...req.query, limit: req.query.limit ?? 25 });
    return { items: p.items.map(ser), nextCursor: p.nextCursor };
  });

  app.post('/holders', {
    config: { permission: 'holders:write' },
    schema: { body: Obj({ kind: Kind, name: Type.String({ minLength: 1, maxLength: 120 }), code: Type.Optional(Type.String({ maxLength: 60 })), jobId: Type.Optional(Uuid) }), response: { 201: View } },
  }, async (req, reply) => reply.code(201).send(ser(await svc.createHolder(app.db, actorOf(req), req.body))));

  app.get('/holders/:id', { config: { permission: 'holders:read' }, schema: { params: IdParams, response: { 200: View } } },
    async (req) => ser(await svc.getHolder(app.db, req.user!.orgId, req.params.id)));

  app.patch('/holders/:id', {
    config: { permission: 'holders:write' },
    schema: { params: IdParams, body: Obj({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), code: Type.Optional(Nullable(Type.String({ maxLength: 60 }))) }, { minProperties: 1 }), response: { 200: View } },
  }, async (req) => ser(await svc.updateHolder(app.db, actorOf(req), req.params.id, req.body)));

  app.post('/holders/:id/archive', { config: { permission: 'holders:write' }, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.archiveHolder(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });

  app.get('/holders/:id/members', {
    config: { permission: 'holders:read' },
    schema: { params: IdParams, response: { 200: Obj({ items: Type.Array(Obj({ id: Uuid, name: Type.String() })) }) } },
  }, async (req) => ({ items: await svc.getMembers(app.db, req.user!.orgId, req.params.id) }));

  app.put('/holders/:id/members', {
    config: { permission: 'holders:write' },
    schema: { params: IdParams, body: Obj({ personIds: Type.Array(Uuid, { maxItems: 500 }) }), response: { 200: Obj({ personIds: Type.Array(Uuid) }) } },
  }, async (req) => {
    if (req.user!.role !== 'admin') { const { ForbiddenError } = await import('../../lib/errors.js'); throw new ForbiddenError('Only administrators manage team membership'); }
    return { personIds: await svc.setMembers(app.db, actorOf(req), req.params.id, req.body.personIds) };
  });
}
