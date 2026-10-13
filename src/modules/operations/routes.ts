import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, eq, sql } from 'drizzle-orm';
import { pendingApprovals, syncIssues } from '../../db/schema.js';
import { IsoDate, Nullable, Obj, Uuid, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import { getOrganization } from '../organization/service.js';
import { getSettings } from '../organization/settings.service.js';
import { openDiscrepancyCount } from '../reconciliation/queries.js';
import { categoryStats, dashboardCounts, lowStockPage, outstandingPage, type OutstandingRow } from './queries.js';
import { listShelves } from '../shelves/service.js';
import { listCategories } from '../categories/service.js';

const Page = { cursor: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })) };
const OutstandingView = Obj({
  item: Obj({ id: Uuid, itemNumber: Type.String(), name: Type.String(), type: lits(['asset', 'consumable']), unit: Type.String() }),
  holder: Obj({ id: Uuid, name: Type.String(), kind: Type.String() }),
  quantity: Type.Integer(), issuedQuantity: Type.Integer(), returnedQuantity: Type.Integer(), partialReturn: Type.Boolean(), since: Nullable(IsoDate), dueAt: Nullable(IsoDate), jobId: Nullable(Uuid),
  dueStatus: Nullable(lits(['on_time', 'due_soon', 'overdue'])), overdueByHours: Nullable(Type.Integer()),
});
const LowStockView = Obj({
  item: Obj({ id: Uuid, itemNumber: Type.String(), name: Type.String(), unit: Type.String(), categoryName: Nullable(Type.String()) }),
  quantity: Type.Integer(), minimum: Type.Integer(), shortfall: Type.Integer(), headroom: Type.Integer(), status: lits(['low', 'near']), outOfStock: Type.Boolean(), reorderQuantity: Nullable(Type.Integer()),
});

export const serializeOutstanding = (r: OutstandingRow, dueSoonHours: number, now = new Date()) => {
  let dueStatus: 'on_time' | 'due_soon' | 'overdue' | null = null;
  // Assets are always on a clock (no due date ⇒ on time); a consumable line has a status only if a due date was set on its oldest open issue.
  if (r.item_type === 'asset' || r.due_at) dueStatus = !r.due_at ? 'on_time' : r.due_at < now ? 'overdue' : r.due_at.getTime() - now.getTime() <= dueSoonHours * 3_600_000 ? 'due_soon' : 'on_time';
  return {
    item: { id: r.item_id, itemNumber: r.item_number, name: r.item_name, type: r.item_type, unit: r.unit },
    holder: { id: r.holder_id, name: r.holder_name, kind: r.holder_kind },
    quantity: r.quantity, issuedQuantity: r.issued, returnedQuantity: r.returned, partialReturn: r.returned > 0 && r.quantity > 0, since: r.since ? r.since.toISOString() : null, dueAt: r.due_at ? r.due_at.toISOString() : null, jobId: r.job_id,
    dueStatus, overdueByHours: r.overdue && r.due_at ? Math.floor((now.getTime() - r.due_at.getTime()) / 3_600_000) : null,
  };
};

const Stats = Obj({ assets: Type.Integer(), products: Type.Integer(), units: Type.Integer(), checkedOut: Type.Integer(), underRepair: Type.Integer(), damaged: Type.Integer(), lost: Type.Integer(), lowStock: Type.Integer(), nearMinimum: Type.Integer(), overdue: Type.Integer() });
const Attention = lits(['overdue', 'low_stock', 'near_minimum', 'under_repair', 'damaged', 'lost']);
const ZERO = { category_id: '', assets: 0, products: 0, units: 0, checked_out: 0, under_repair: 0, damaged: 0, lost: 0, low_stock: 0, near_minimum: 0, overdue: 0 };
const toStats = (r: typeof ZERO) => ({ assets: r.assets, products: r.products, units: r.units, checkedOut: r.checked_out, underRepair: r.under_repair, damaged: r.damaged, lost: r.lost, lowStock: r.low_stock, nearMinimum: r.near_minimum, overdue: r.overdue });
const sum = (a: ReturnType<typeof toStats>, b: ReturnType<typeof toStats>) => Object.fromEntries(Object.keys(a).map((k) => [k, (a as Record<string, number>)[k] + (b as Record<string, number>)[k]])) as ReturnType<typeof toStats>;
const attention = (s: ReturnType<typeof toStats>) => (['overdue', 'low_stock', 'near_minimum', 'under_repair', 'damaged', 'lost'] as const).filter((k) => ({ overdue: s.overdue, low_stock: s.lowStock, near_minimum: s.nearMinimum, under_repair: s.underRepair, damaged: s.damaged, lost: s.lost })[k] > 0);

export default async function operationsRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  // The Collections view: shelves → categories with what is in, what is out and what needs attention.
  app.get('/collections', {
    config: { permission: 'ops:read' },
    schema: {
      querystring: Obj({ shelfId: Type.Optional(Uuid) }),
      response: { 200: Obj({ shelves: Type.Array(Obj({
        id: Uuid, name: Type.String(), code: Type.String(), locationId: Uuid, stats: Stats, attention: Type.Array(Attention),
        categories: Type.Array(Obj({ id: Uuid, name: Type.String(), codePrefix: Nullable(Type.String()), itemCount: Type.Integer(), stats: Stats, attention: Type.Array(Attention) })),
      })), generatedAt: IsoDate }) },
    },
  }, async (req) => {
    const orgId = req.user!.orgId;
    const [shelves, cats, stats] = await Promise.all([listShelves(app.db, orgId, {}), listCategories(app.db, orgId, { shelfId: req.query.shelfId }), categoryStats(app.db, orgId, (await getSettings(app.db, orgId, app.cache)).nearMinimumPercent)]);
    return {
      generatedAt: new Date().toISOString(),
      shelves: shelves.filter((s) => !req.query.shelfId || s.id === req.query.shelfId).map((s) => {
        const mine = cats.filter((c) => c.shelfId === s.id).map((c) => { const st = toStats(stats.get(c.id) ?? ZERO); return { id: c.id, name: c.name, codePrefix: c.codePrefix, itemCount: c.itemCount, stats: st, attention: attention(st) }; });
        const total = mine.reduce((acc, c) => sum(acc, c.stats), toStats(ZERO));
        return { id: s.id, name: s.name, code: s.code, locationId: s.locationId, stats: total, attention: attention(total), categories: mine };
      }),
    };
  });


  app.get('/outstanding', {
    config: { permission: 'ops:read' },
    schema: { querystring: Obj({ ...Page, holderId: Type.Optional(Uuid), type: Type.Optional(lits(['asset', 'consumable'])), overdue: Type.Optional(Type.Boolean()), q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }), response: { 200: Obj({ items: Type.Array(OutstandingView), nextCursor: Nullable(Type.String()) }) } },
  }, async (req) => {
    const { rows, nextCursor } = await outstandingPage(app.db, req.user!.orgId, { holderId: req.query.holderId, type: req.query.type, overdueOnly: req.query.overdue, q: req.query.q, cursor: req.query.cursor, limit: req.query.limit ?? 25 });
    const hours = (await getSettings(app.db, req.user!.orgId, app.cache)).dueSoonHours;
    return { items: rows.map((r) => serializeOutstanding(r, hours)), nextCursor };
  });

  app.get('/overdue', {
    config: { permission: 'ops:read' },
    schema: { querystring: Obj({ ...Page, holderId: Type.Optional(Uuid) }), response: { 200: Obj({ items: Type.Array(OutstandingView), nextCursor: Nullable(Type.String()) }) } },
  }, async (req) => {
    const { rows, nextCursor } = await outstandingPage(app.db, req.user!.orgId, { holderId: req.query.holderId, overdueOnly: true, cursor: req.query.cursor, limit: req.query.limit ?? 25 });
    const hours = (await getSettings(app.db, req.user!.orgId, app.cache)).dueSoonHours;
    return { items: rows.map((r) => serializeOutstanding(r, hours)), nextCursor };
  });

  app.get('/low-stock', {
    config: { permission: 'ops:read' },
    schema: { querystring: Obj({ ...Page, q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), includeNear: Type.Optional(Type.Boolean()) }), response: { 200: Obj({ items: Type.Array(LowStockView), nextCursor: Nullable(Type.String()) }) } },
  }, async (req) => {
    const { rows, nextCursor } = await lowStockPage(app.db, req.user!.orgId, { cursor: req.query.cursor, limit: req.query.limit ?? 25, q: req.query.q, includeNear: req.query.includeNear, nearPct: (await getSettings(app.db, req.user!.orgId, app.cache)).nearMinimumPercent });
    return {
      nextCursor,
      items: rows.map((r) => ({
        item: { id: r.item_id, itemNumber: r.item_number, name: r.item_name, unit: r.unit, categoryName: r.category_name },
        quantity: r.quantity, minimum: r.minimum, shortfall: Math.max(r.minimum - r.quantity, 0), headroom: Math.max(r.quantity - r.minimum, 0), status: r.status, outOfStock: r.quantity === 0, reorderQuantity: r.reorder_quantity,
      })),
    };
  });

  app.get('/dashboard', {
    config: { permission: 'ops:read' },
    schema: { response: { 200: Obj({
      lowStock: Type.Integer(), nearMinimum: Type.Integer(), outstanding: Type.Integer(), overdue: Type.Integer(), dueSoon: Type.Integer(), todayTransactions: Type.Integer(),
      openDiscrepancies: Type.Integer(), pendingApprovals: Type.Integer(), openSyncIssues: Type.Integer(), activeItems: Type.Integer(), timezone: Type.String(), generatedAt: IsoDate,
    }) } },
  }, async (req) => {
    const u = req.user!;
    const [org, settings] = await Promise.all([getOrganization(app.db, u.orgId), getSettings(app.db, u.orgId, app.cache)]);
    const now = new Date();
    const [c, discrepancies, pending, sync] = await Promise.all([
      dashboardCounts(app.db, u.orgId, org.timezone, settings.dueSoonHours, settings.nearMinimumPercent, now),
      openDiscrepancyCount(app.db, u.orgId),
      u.role === 'viewer' ? 0 : app.db.select({ n: sql<number>`count(*)::int` }).from(pendingApprovals)
        .where(and(eq(pendingApprovals.orgId, u.orgId), eq(pendingApprovals.status, 'pending'), u.role === 'store_staff' ? eq(pendingApprovals.requestedBy, u.id) : undefined)).then((r) => r[0].n),
      ['admin', 'supervisor'].includes(u.role) ? app.db.select({ n: sql<number>`count(*)::int` }).from(syncIssues).where(and(eq(syncIssues.orgId, u.orgId), eq(syncIssues.status, 'open'))).then((r) => r[0].n) : 0,
    ]);
    return {
      lowStock: c.low_stock, nearMinimum: c.near_minimum, outstanding: c.outstanding, overdue: c.overdue, dueSoon: c.due_soon, todayTransactions: c.today_transactions,
      openDiscrepancies: discrepancies, pendingApprovals: pending, openSyncIssues: sync, activeItems: c.active_items, timezone: org.timezone, generatedAt: now.toISOString(),
    };
  });
}
