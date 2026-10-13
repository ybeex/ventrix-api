import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { actorOf } from '../../lib/actor.js';
import { audit, auditSafe } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { IsoDate, Nullable, Obj, Uuid, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import { TxType } from '../transactions/views.js';
import { csvStream } from './csv.js';
import { REPORTS, allPages } from './service.js';

export default async function reportRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.get('/reports', {
    config: { permission: 'reports:read' },
    schema: { response: { 200: Obj({ items: Type.Array(Obj({ name: Type.String(), title: Type.String(), description: Type.String(), columns: Type.Array(Obj({ key: Type.String(), label: Type.String() })) })) }) } },
  }, async () => ({ items: Object.values(REPORTS).map(({ name, title, description, columns }) => ({ name, title, description, columns })) }));

  app.get('/reports/:name', {
    config: { permission: 'reports:read' },
    schema: {
      params: Obj({ name: Type.String({ maxLength: 40 }) }),
      querystring: Obj({
        format: Type.Optional(lits(['json', 'csv'])), cursor: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
        type: Type.Optional(Type.String({ maxLength: 20 })), categoryId: Type.Optional(Uuid), lowStockOnly: Type.Optional(Type.Boolean()), holderId: Type.Optional(Uuid), overdueOnly: Type.Optional(Type.Boolean()),
        itemId: Type.Optional(Uuid), actorId: Type.Optional(Uuid), jobId: Type.Optional(Uuid), from: Type.Optional(IsoDate), to: Type.Optional(IsoDate), status: Type.Optional(lits(['open', 'resolved', 'all'])),
        txType: Type.Optional(TxType),
      }),
      response: { 200: Obj({ report: Type.String(), columns: Type.Array(Obj({ key: Type.String(), label: Type.String() })), rows: Type.Array(Type.Record(Type.String(), Type.Any())), nextCursor: Nullable(Type.String()) }) },
    },
  }, async (req, reply) => {
    const def = REPORTS[req.params.name];
    if (!def) throw new NotFoundError('Report');
    const { format, cursor, limit, from, to, txType, ...rest } = req.query;
    const filters = { ...rest, type: def.name === 'transactions' ? txType : rest.type, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
    const orgId = req.user!.orgId;

    if (format !== 'csv') {
      const { rows, nextCursor } = await def.page(app.db, orgId, filters, cursor, limit ?? 50);
      // Opening a report is logged (the first page only — paging through one report is one view).
      if (!cursor) await auditSafe(app.db, actorOf(req), { action: 'report.viewed', entityType: 'report', entityId: def.name, next: { filters: { ...rest, txType, from, to } } });
      return { report: def.name, columns: def.columns, rows, nextCursor };
    }
    // Exports are themselves auditable events (who pulled what data, with which filters).
    await app.db.transaction((tx) => audit(tx, actorOf(req), { action: 'report.exported', entityType: 'report', entityId: def.name, next: { filters: { ...rest, txType, from, to }, format: 'csv' } }));
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${def.name}-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csvStream(def.columns, allPages(def, app.db, orgId, filters)) as never);
  });
}
