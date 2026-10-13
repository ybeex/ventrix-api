import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { Type } from '@sinclair/typebox';
import { actorOf } from '../../lib/actor.js';
import { IdParams, IsoDate, Nullable, Obj, Uuid, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

export const ShelfView = Obj({
  id: Uuid, locationId: Uuid, name: Type.String(), code: Type.String(), description: Nullable(Type.String()), position: Type.Integer(), cycleCountDays: Nullable(Type.Integer()),
  categoryCount: Type.Integer(), itemCount: Type.Integer(), lastCountedAt: Nullable(IsoDate), nextCountDueAt: Nullable(IsoDate), archivedAt: Nullable(IsoDate), createdAt: IsoDate,
});
export const serShelf = (s: svc.ShelfListRow) => ({
  id: s.id, locationId: s.locationId, name: s.name, code: s.code, description: s.description, position: s.position, cycleCountDays: s.cycleCountDays,
  categoryCount: s.categoryCount, itemCount: s.itemCount, lastCountedAt: s.lastCountedAt?.toISOString() ?? null, nextCountDueAt: s.nextCountDueAt?.toISOString() ?? null, archivedAt: s.archivedAt?.toISOString() ?? null, createdAt: s.createdAt.toISOString(),
});
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Code = Type.String({ minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9._-]+$' });

export default async function shelfRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const full = async (orgId: string, id: string) => serShelf(await svc.getShelf(app.db, orgId, id));

  app.get('/shelves', {
    config: { permission: 'shelves:read' },
    schema: { querystring: Obj({ includeArchived: Type.Optional(Type.Boolean()), locationId: Type.Optional(Uuid) }), response: { 200: Obj({ items: Type.Array(ShelfView) }) } },
  }, async (req) => ({ items: (await svc.listShelves(app.db, req.user!.orgId, req.query)).map(serShelf) }));

  app.post('/shelves', {
    config: { permission: 'shelves:manage' },
    schema: { body: Obj({ name: Name, locationId: Type.Optional(Uuid), description: Type.Optional(Type.String({ maxLength: 500 })), code: Type.Optional(Code), position: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })), cycleCountDays: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 365 }))) }), response: { 201: ShelfView } },
  }, async (req, reply) => reply.code(201).send(await full(req.user!.orgId, (await svc.createShelf(app.db, actorOf(req), req.body)).id)));

  app.get('/shelves/lookup', {
    config: { permission: 'shelves:read' },
    schema: { querystring: Obj({ code: Type.String({ minLength: 1, maxLength: 60 }) }), response: { 200: ShelfView } },
  }, async (req) => serShelf(await svc.lookupShelf(app.db, req.user!.orgId, req.query.code)));

  app.get('/shelves/:id', { config: { permission: 'shelves:read' }, schema: { params: IdParams, response: { 200: ShelfView } } },
    async (req) => full(req.user!.orgId, req.params.id));

  app.patch('/shelves/:id', {
    config: { permission: 'shelves:manage' },
    schema: {
      params: IdParams,
      body: Obj({ name: Type.Optional(Name), locationId: Type.Optional(Uuid), description: Type.Optional(Nullable(Type.String({ maxLength: 500 }))), code: Type.Optional(Code), position: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })), cycleCountDays: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 365 }))) }, { minProperties: 1 }),
      response: { 200: ShelfView },
    },
  }, async (req) => { await svc.updateShelf(app.db, actorOf(req), req.params.id, req.body as never); return full(req.user!.orgId, req.params.id); });

  app.post('/shelves/:id/archive', { config: { permission: 'shelves:manage' }, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.archiveShelf(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });
  app.post('/shelves/:id/restore', { config: { permission: 'shelves:manage' }, schema: { params: IdParams, response: { 200: ShelfView } } },
    async (req) => { await svc.restoreShelf(app.db, actorOf(req), req.params.id); return full(req.user!.orgId, req.params.id); });

  app.get('/shelves/:id/qr', {
    config: { permission: 'shelves:read' },
    schema: { params: IdParams, querystring: Obj({ format: Type.Optional(lits(['svg', 'png'])) }) },
  }, async (req, reply) => {
    const s = await svc.getShelf(app.db, req.user!.orgId, req.params.id);
    // The shelf tag encodes its code: scanning it resolves via GET /shelves/lookup and starts a count against the shelf.
    if (req.query.format === 'png') return reply.type('image/png').send(await QRCode.toBuffer(s.code, { margin: 2, width: 512, errorCorrectionLevel: 'M' }));
    return reply.type('image/svg+xml').send(await QRCode.toString(s.code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  });
}
