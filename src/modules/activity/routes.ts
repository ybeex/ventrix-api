import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { actorOf } from '../../lib/actor.js';
import { IsoDate, Nullable, Obj, PageOf, PageQuery, Uuid, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import { csvStream } from '../reports/csv.js';
import { actionCatalog, listActivity, type ActivityFilters } from './service.js';
import { audit, auditSafe } from '../../lib/audit.js';

const View = Obj({
  id: Uuid, sequence: Type.Integer(), action: Type.String(), label: Type.String(), category: Type.String(), summary: Type.String(),
  entity: Obj({ type: Type.String(), id: Type.String(), name: Nullable(Type.String()) }),
  actor: Nullable(Obj({ id: Uuid, name: Nullable(Type.String()) })), previous: Type.Any(), next: Type.Any(), reason: Nullable(Type.String()),
  transactionId: Nullable(Uuid), requestId: Nullable(Type.String()), ip: Nullable(Type.String()), createdAt: IsoDate,
});

export default async function activityRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  // Every event type the log can contain, with its label and category — drives the Activity filters.
  app.get('/activity/actions', {
    config: { permission: 'activity:read' },
    schema: { response: { 200: Obj({ items: Type.Array(Obj({ action: Type.String(), label: Type.String(), category: Type.String() })), categories: Type.Array(Type.String()) }) } },
  }, async () => { const items = actionCatalog(); return { items, categories: [...new Set(items.map((i) => i.category))] }; });

  app.get('/activity', {
    config: { permission: 'activity:read' },
    schema: {
      querystring: Obj({
        ...PageQuery, action: Type.Optional(Type.String({ maxLength: 100, pattern: '^[a-z_.*]+$' })), category: Type.Optional(Type.String({ maxLength: 40 })), entityType: Type.Optional(Type.String({ maxLength: 60 })), entityId: Type.Optional(Type.String({ maxLength: 80 })),
        actorId: Type.Optional(Uuid), from: Type.Optional(IsoDate), to: Type.Optional(IsoDate), format: Type.Optional(lits(['json', 'csv'])),
      }),
      response: { 200: PageOf(View) },
    },
  }, async (req, reply) => {
    const { from, to, limit, format, ...rest } = req.query;
    const base = { ...rest, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
    if (format !== 'csv') {
      if (!rest.cursor) await auditSafe(app.db, actorOf(req), { action: 'activity.viewed', entityType: 'report', entityId: 'activity', next: { filters: { ...rest, from, to } } });
      return listActivity(app.db, req.user!.orgId, { ...base, limit: limit ?? 25 });
    }

    await app.db.transaction((tx) => audit(tx, actorOf(req), { action: 'report.exported', entityType: 'report', entityId: 'activity', next: { filters: { ...rest, from, to }, format: 'csv' } }));
    async function* pages() {
      let cursor: string | undefined = base.cursor;
      let total = 0;
      do {
        const p = await listActivity(app.db, req.user!.orgId, { ...base, cursor, limit: 1000 } as ActivityFilters);
        total += p.items.length;
        if (total > 200_000) throw new Error('Export exceeds 200000 rows; narrow the filters');
        if (p.items.length) yield p.items.map((e) => ({ when: e.createdAt, summary: e.summary, action: e.action, entityType: e.entity.type, entityId: e.entity.id, actor: e.actor?.name ?? '', reason: e.reason ?? '', transactionId: e.transactionId ?? '' }));
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
    }
    const cols = [{ key: 'when', label: 'Time (UTC)' }, { key: 'summary', label: 'What happened' }, { key: 'action', label: 'Event' }, { key: 'entityType', label: 'Entity type' }, { key: 'entityId', label: 'Entity ID' }, { key: 'actor', label: 'Performed by' }, { key: 'reason', label: 'Reason' }, { key: 'transactionId', label: 'Transaction' }];
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`).send(csvStream(cols, pages()) as never);
  });
}
