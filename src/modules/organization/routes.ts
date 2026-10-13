import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Nullable, Obj, Uuid, IsoDate } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import { getPolicy, getSettings } from './settings.service.js';
import * as svc from './service.js';

const Mode = Type.Union([Type.Literal('direct'), Type.Literal('staff_approval'), Type.Literal('all_approval')]);
const OrgView = Obj({ id: Uuid, name: Type.String(), slug: Type.String(), timezone: Type.String(), createdAt: IsoDate });
const SettingsView = Obj({
  reconciliationRequireReason: Type.Boolean(), staffCanManageItems: Type.Boolean(), requirePhotoFor: Type.Array(Type.String()),
  notificationEmailTypes: Type.Array(Type.String()), dueSoonHours: Type.Integer(),
  nearMinimumPercent: Type.Integer(), supervisorsCanInvite: Type.Boolean(),
});
const PolicyView = Obj({
  adjustmentMode: Mode, lossMode: Mode, retirementMode: Mode, checkoutMode: Mode, checkinMode: Mode, largeAdjustmentThreshold: Nullable(Type.Integer()),
});
const PHOTO_OPS = ['checkout', 'checkin', 'damage', 'adjustment', 'reconciliation'] as const;
const NOTIFY_TYPES = ['low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending', 'approval_decided', 'announcement', 'cycle_count_due'] as const;
const lit = <T extends readonly string[]>(vals: T) => Type.Union(vals.map((v) => Type.Literal(v)) as never) as never;

export default async function organizationRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.get('/organization', { config: { permission: 'org:read' }, schema: { response: { 200: OrgView } } }, async (req) => {
    const o = await svc.getOrganization(app.db, req.user!.orgId);
    return { ...o, createdAt: o.createdAt.toISOString() };
  });

  app.patch('/organization', {
    config: { permission: 'org:manage' },
    schema: { body: Obj({ name: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })), timezone: Type.Optional(Type.String({ maxLength: 60 })) }, { minProperties: 1 }), response: { 200: OrgView } },
  }, async (req) => {
    const o = await svc.updateOrganization(app.db, actorOf(req), req.body);
    return { ...o, createdAt: o.createdAt.toISOString() };
  });

  app.get('/organization/settings', { config: { permission: 'org:read' }, schema: { response: { 200: SettingsView } } },
    async (req) => getSettings(app.db, req.user!.orgId, app.cache));

  app.patch('/organization/settings', {
    config: { permission: 'org:manage' },
    schema: {
      body: Obj({
        reconciliationRequireReason: Type.Optional(Type.Boolean()), staffCanManageItems: Type.Optional(Type.Boolean()),
        requirePhotoFor: Type.Optional(Type.Array(lit(PHOTO_OPS), { uniqueItems: true })),
        notificationEmailTypes: Type.Optional(Type.Array(lit(NOTIFY_TYPES), { uniqueItems: true })),
        dueSoonHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
        nearMinimumPercent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })), supervisorsCanInvite: Type.Optional(Type.Boolean()),
      }, { minProperties: 1 }),
      response: { 200: SettingsView },
    },
  }, async (req) => {
    const s = await svc.updateSettings(app.db, app.cache, actorOf(req), req.body as never);
    return { reconciliationRequireReason: s.reconciliationRequireReason, staffCanManageItems: s.staffCanManageItems, requirePhotoFor: s.requirePhotoFor, notificationEmailTypes: s.notificationEmailTypes, dueSoonHours: s.dueSoonHours, nearMinimumPercent: s.nearMinimumPercent, supervisorsCanInvite: s.supervisorsCanInvite };
  });

  app.get('/organization/approval-policy', { config: { permission: 'org:read' }, schema: { response: { 200: PolicyView } } },
    async (req) => getPolicy(app.db, req.user!.orgId));

  app.put('/organization/approval-policy', {
    config: { permission: 'policy:manage' },
    schema: { body: PolicyView, response: { 200: PolicyView } },
  }, async (req) => svc.updatePolicy(app.db, actorOf(req), req.body));
}
