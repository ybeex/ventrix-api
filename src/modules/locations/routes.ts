import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, Uuid } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

const Kind = Type.Union([Type.Literal('store'), Type.Literal('site'), Type.Literal('warehouse'), Type.Literal('area')]);
const View = Obj({ id: Uuid, name: Type.String(), kind: Kind, parentId: Nullable(Uuid), address: Nullable(Type.String()), isDefault: Type.Boolean(), archivedAt: Nullable(IsoDate), createdAt: IsoDate });
const ser = (l: Awaited<ReturnType<typeof svc.createLocation>>) => ({ ...l, archivedAt: l.archivedAt?.toISOString() ?? null, createdAt: l.createdAt.toISOString() });

export default async function locationRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.get('/locations', { config: { permission: 'locations:read' }, schema: { response: { 200: Obj({ items: Type.Array(View) }) } } },
    async (req) => ({ items: (await svc.listLocations(app.db, req.user!.orgId)).map(ser) }));

  app.post('/locations', {
    config: { permission: 'locations:manage' },
    schema: { body: Obj({ name: Type.String({ minLength: 1, maxLength: 120 }), kind: Type.Optional(Kind), parentId: Type.Optional(Uuid), address: Type.Optional(Type.String({ maxLength: 300 })) }), response: { 201: View } },
  }, async (req, reply) => reply.code(201).send(ser(await svc.createLocation(app.db, actorOf(req), req.body))));

  app.patch('/locations/:id', {
    config: { permission: 'locations:manage' },
    schema: { params: IdParams, body: Obj({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), address: Type.Optional(Nullable(Type.String({ maxLength: 300 }))) }, { minProperties: 1 }), response: { 200: View } },
  }, async (req) => ser(await svc.updateLocation(app.db, actorOf(req), req.params.id, req.body)));

  app.post('/locations/:id/archive', { config: { permission: 'locations:manage' }, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.archiveLocation(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });
}
