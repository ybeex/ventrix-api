import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, Uuid } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

export const CategoryView = Obj({
  id: Uuid, shelfId: Uuid, shelfName: Type.String(), name: Type.String(), codePrefix: Nullable(Type.String()), defaultMinQuantity: Nullable(Type.Integer()),
  defaultExpectedReturnHours: Nullable(Type.Integer()), itemCount: Type.Integer(), archivedAt: Nullable(IsoDate), createdAt: IsoDate,
});
export const serCategory = (c: svc.CategoryListRow) => ({
  id: c.id, shelfId: c.shelfId, shelfName: c.shelfName, name: c.name, codePrefix: c.codePrefix, defaultMinQuantity: c.defaultMinQuantity,
  defaultExpectedReturnHours: c.defaultExpectedReturnHours, itemCount: c.itemCount, archivedAt: c.archivedAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
});
const Fields = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  codePrefix: Nullable(Type.String({ pattern: '^[A-Z0-9]{2,6}$' })),
  defaultMinQuantity: Nullable(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
  defaultExpectedReturnHours: Nullable(Type.Integer({ minimum: 1, maximum: 8760 })),
};

export default async function categoryRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const full = async (orgId: string, id: string) => serCategory(await svc.getCategory(app.db, orgId, id));

  app.get('/categories', {
    config: { permission: 'categories:read' },
    schema: { querystring: Obj({ includeArchived: Type.Optional(Type.Boolean()), shelfId: Type.Optional(Uuid) }), response: { 200: Obj({ items: Type.Array(CategoryView) }) } },
  }, async (req) => ({ items: (await svc.listCategories(app.db, req.user!.orgId, req.query)).map(serCategory) }));

  app.post('/categories', {
    config: { permission: 'categories:manage' },
    schema: { body: Obj({ shelfId: Uuid, name: Fields.name, codePrefix: Type.Optional(Fields.codePrefix), defaultMinQuantity: Type.Optional(Fields.defaultMinQuantity), defaultExpectedReturnHours: Type.Optional(Fields.defaultExpectedReturnHours) }), response: { 201: CategoryView } },
  }, async (req, reply) => reply.code(201).send(await full(req.user!.orgId, (await svc.createCategory(app.db, actorOf(req), req.body)).id)));

  app.get('/categories/:id', { config: { permission: 'categories:read' }, schema: { params: IdParams, response: { 200: CategoryView } } },
    async (req) => full(req.user!.orgId, req.params.id));

  app.patch('/categories/:id', {
    config: { permission: 'categories:manage' },
    schema: { params: IdParams, body: Obj({ name: Type.Optional(Fields.name), codePrefix: Type.Optional(Fields.codePrefix), defaultMinQuantity: Type.Optional(Fields.defaultMinQuantity), defaultExpectedReturnHours: Type.Optional(Fields.defaultExpectedReturnHours) }, { minProperties: 1 }), response: { 200: CategoryView } },
  }, async (req) => { await svc.updateCategory(app.db, actorOf(req), req.params.id, req.body); return full(req.user!.orgId, req.params.id); });

  app.post('/categories/:id/move', {
    config: { permission: 'categories:manage' },
    schema: { params: IdParams, body: Obj({ shelfId: Uuid }), response: { 200: Obj({ category: CategoryView, itemsRelocated: Type.Integer() }) } },
  }, async (req) => {
    const r = await svc.moveCategory(app.db, actorOf(req), req.params.id, req.body.shelfId);
    return { category: await full(req.user!.orgId, req.params.id), itemsRelocated: r.itemsRelocated };
  });

  app.post('/categories/:id/archive', { config: { permission: 'categories:manage' }, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.archiveCategory(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });
  app.post('/categories/:id/restore', { config: { permission: 'categories:manage' }, schema: { params: IdParams, response: { 200: CategoryView } } },
    async (req) => { await svc.restoreCategory(app.db, actorOf(req), req.params.id); return full(req.user!.orgId, req.params.id); });
}
