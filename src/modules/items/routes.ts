import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid, lits, emptyBodyOk } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { requireIdempotencyKey } from '../../lib/idempotency-header.js';
import { typed } from '../../types.js';
import { getSettings } from '../organization/settings.service.js';
import { AssetState, ConditionSchema, TxView, serializeTx } from '../transactions/views.js';
import * as q from './queries.js';
import * as svc from './service.js';

export const ItemView = Obj({
  id: Uuid, itemNumber: Type.String(), type: lits(['asset', 'consumable']), sku: Nullable(Type.String()), code: Type.String(), name: Type.String(),
  description: Nullable(Type.String()), categoryId: Uuid, categoryName: Nullable(Type.String()), shelfId: Nullable(Uuid), shelfName: Nullable(Type.String()), locationId: Uuid, photoFileId: Nullable(Uuid), unit: Type.String(),
  assetState: Nullable(AssetState), condition: Nullable(ConditionSchema), currentHolder: Nullable(Obj({ id: Uuid, name: Type.String() })),
  currentJobId: Nullable(Uuid), checkedOutAt: Nullable(IsoDate), dueAt: Nullable(IsoDate), dueStatus: Nullable(lits(['on_time', 'due_soon', 'overdue'])), expectedReturnHours: Nullable(Type.Integer()),
  quantityAvailable: Nullable(Type.Integer()), minQuantity: Nullable(Type.Integer()), effectiveMinQuantity: Nullable(Type.Integer()), reorderQuantity: Nullable(Type.Integer()), lowStock: Type.Boolean(), nearMinimum: Type.Boolean(),
  archivedAt: Nullable(IsoDate), createdAt: IsoDate, updatedAt: IsoDate,
});

const Text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const Sku = Type.String({ minLength: 1, maxLength: 80 });
const Code = Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._-]+$' });

export default async function itemRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const dueSoon = async (orgId: string) => getSettings(app.db, orgId, app.cache); // settings object: due-soon window + near-minimum band

  app.get('/items', {
    config: { permission: 'items:read' },
    schema: {
      querystring: Obj({
        ...PageQuery, q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), type: Type.Optional(lits(['asset', 'consumable'])),
        categoryId: Type.Optional(Uuid), shelfId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), holderId: Type.Optional(Uuid),
        status: Type.Optional(lits(['available', 'checked_out', 'lost', 'damaged', 'under_repair', 'retired'])),
        lowStock: Type.Optional(Type.Boolean()), archived: Type.Optional(lits(['exclude', 'include', 'only'])),
      }),
      response: { 200: PageOf(ItemView) },
    },
  }, async (req) => {
    const { rows, nextCursor } = await q.listItems(app.db, req.user!.orgId, { ...req.query, limit: req.query.limit ?? 25 });
    const hours = await dueSoon(req.user!.orgId);
    return { items: rows.map((r) => q.serializeItem(r, hours)), nextCursor };
  });

  app.post('/items', {
    config: { permission: 'items:write' },
    schema: {
      body: Obj({
        type: lits(['asset', 'consumable']), name: Text(160), description: Type.Optional(Type.String({ maxLength: 2000 })), sku: Type.Optional(Sku), code: Type.Optional(Code),
        categoryId: Uuid, unit: Type.Optional(Text(20)), photoFileId: Type.Optional(Uuid),
        expectedReturnHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 8760 })),
        openingQuantity: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
        minQuantity: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })), reorderQuantity: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
      }),
      response: { 200: ItemView, 201: ItemView },
    },
  }, async (req, reply) => {
    const key = requireIdempotencyKey(req.headers);
    const { item, replayed } = await svc.createItem(app.db, actorOf(req), req.body, key);
    const view = q.serializeItem(await q.getItemJoined(app.db, req.user!.orgId, item.id), await dueSoon(req.user!.orgId));
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply.code(replayed ? 200 : 201).send(view);
  });

  app.get('/items/lookup', {
    config: { permission: 'items:read' },
    schema: { querystring: Obj({ code: Type.String({ minLength: 1, maxLength: 120 }) }), response: { 200: ItemView } },
  }, async (req) => q.serializeItem(await q.lookupByCode(app.db, req.user!.orgId, req.query.code), await dueSoon(req.user!.orgId)));

  app.get('/items/recent', {
    config: { permission: 'items:read' },
    schema: { querystring: Obj({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 10 })) }), response: { 200: Obj({ items: Type.Array(ItemView) }) } },
  }, async (req) => {
    const rows = await q.recentItems(app.db, req.user!.orgId, req.user!.id, req.query.limit ?? 10);
    const hours = await dueSoon(req.user!.orgId);
    return { items: rows.map((r) => q.serializeItem(r, hours)) };
  });

  app.get('/items/:id', { config: { permission: 'items:read' }, schema: { params: IdParams, response: { 200: ItemView } } },
    async (req) => q.serializeItem(await q.getItemJoined(app.db, req.user!.orgId, req.params.id), await dueSoon(req.user!.orgId)));

  app.patch('/items/:id', {
    config: { permission: 'items:write' },
    schema: {
      params: IdParams,
      body: Obj({
        name: Type.Optional(Text(160)), description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))), sku: Type.Optional(Nullable(Sku)), code: Type.Optional(Code),
        unit: Type.Optional(Text(20)), photoFileId: Type.Optional(Nullable(Uuid)),
        expectedReturnHours: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 8760 }))),
        minQuantity: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 10_000_000 }))), reorderQuantity: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 10_000_000 }))),
      }, { minProperties: 1 }),
      response: { 200: ItemView },
    },
  }, async (req) => {
    await svc.updateItem(app.db, actorOf(req), req.params.id, req.body);
    return q.serializeItem(await q.getItemJoined(app.db, req.user!.orgId, req.params.id), await dueSoon(req.user!.orgId));
  });

  app.post('/items/move', {
    config: { permission: 'items:write' },
    schema: { body: Obj({ itemIds: Type.Array(Uuid, { minItems: 1, maxItems: 200 }), categoryId: Uuid }), response: { 200: Obj({ moved: Type.Integer(), unchanged: Type.Integer() }) } },
  }, async (req) => svc.moveItems(app.db, actorOf(req), req.body.itemIds, req.body.categoryId));

  app.post('/items/:id/move', {
    config: { permission: 'items:write' },
    schema: { params: IdParams, body: Obj({ categoryId: Uuid }), response: { 200: ItemView } },
  }, async (req) => {
    await svc.moveItem(app.db, actorOf(req), req.params.id, req.body.categoryId);
    return q.serializeItem(await q.getItemJoined(app.db, req.user!.orgId, req.params.id), await dueSoon(req.user!.orgId));
  });

  app.post('/items/:id/archive', {
    config: { permission: 'items:archive' }, preValidation: emptyBodyOk,
    schema: { params: IdParams, body: Obj({ note: Type.Optional(Text(500)) }), response: { 200: ItemView } },
  }, async (req) => {
    await svc.archiveItem(app.db, actorOf(req), req.params.id, req.body.note);
    return q.serializeItem(await q.getItemJoined(app.db, req.user!.orgId, req.params.id), await dueSoon(req.user!.orgId));
  });

  app.post('/items/:id/restore', {
    config: { permission: 'items:archive' }, preValidation: emptyBodyOk,
    schema: { params: IdParams, body: Obj({ note: Type.Optional(Text(500)) }), response: { 200: ItemView } },
  }, async (req) => {
    await svc.restoreItem(app.db, actorOf(req), req.params.id, req.body.note);
    return q.serializeItem(await q.getItemJoined(app.db, req.user!.orgId, req.params.id), await dueSoon(req.user!.orgId));
  });

  app.get('/items/:id/timeline', {
    config: { permission: 'tx:read' },
    schema: { params: IdParams, querystring: Obj(PageQuery), response: { 200: PageOf(TxView) } },
  }, async (req) => {
    await q.getItemJoined(app.db, req.user!.orgId, req.params.id); // 404 for unknown / other-tenant items
    const { rows, nextCursor } = await q.itemTimeline(app.db, req.user!.orgId, req.params.id, { cursor: req.query.cursor, limit: req.query.limit ?? 25 });
    return { items: rows.map((r) => serializeTx(r)), nextCursor };
  });

  app.get('/items/:id/qr', {
    config: { permission: 'items:read' },
    schema: { params: IdParams, querystring: Obj({ format: Type.Optional(lits(['svg', 'png'])) }) },
  }, async (req, reply) => {
    const { item } = await q.getItemJoined(app.db, req.user!.orgId, req.params.id);
    // The QR encodes the scannable code — exactly what GET /items/lookup resolves.
    if (req.query.format === 'png') return reply.type('image/png').send(await QRCode.toBuffer(item.code, { margin: 2, width: 512, errorCorrectionLevel: 'M' }));
    return reply.type('image/svg+xml').send(await QRCode.toString(item.code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  });
}
