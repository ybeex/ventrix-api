import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { actorOf } from '../../lib/actor.js';
import { IdParams, IsoDate, Nullable, Obj, Uuid, lits } from '../../lib/strict.js';
import { typed } from '../../types.js';
import * as svc from './announcements.js';
import { getRules, ROUTABLE_TYPES, setRule, type NotificationType } from './service.js';

const Roles = lits(['admin', 'supervisor', 'store_staff', 'viewer']);
const Severity = lits(['info', 'warning', 'critical']);
const View = Obj({
  id: Uuid, title: Type.String(), body: Type.String(), severity: Severity, audienceRoles: Type.Array(Type.String()), sendEmail: Type.Boolean(),
  publishedBy: Obj({ id: Uuid, name: Nullable(Type.String()) }), createdAt: IsoDate, expiresAt: Nullable(IsoDate), retractedAt: Nullable(IsoDate),
  status: lits(['active', 'expired', 'retracted']), delivered: Nullable(Type.Integer()), read: Nullable(Type.Integer()),
});

export default async function announcementRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const one = async (req: Parameters<typeof actorOf>[0], id: string) => (await svc.listAnnouncements(app.db, actorOf(req), { all: true })).find((a) => a.id === id)!;

  app.get('/announcements', {
    config: { permission: 'announcements:read' },
    schema: { querystring: Obj({ all: Type.Optional(Type.Boolean()) }), response: { 200: Obj({ items: Type.Array(View) }) } },
  }, async (req) => ({ items: await svc.listAnnouncements(app.db, actorOf(req), { all: req.query.all }) as never }));

  app.post('/announcements', {
    config: { permission: 'announcements:manage', idempotent: true },
    schema: {
      body: Obj({ title: Type.String({ minLength: 1, maxLength: 160 }), body: Type.String({ minLength: 1, maxLength: 4000 }), severity: Type.Optional(Severity), audienceRoles: Type.Optional(Type.Array(Roles, { maxItems: 4 })), sendEmail: Type.Optional(Type.Boolean()), expiresAt: Type.Optional(IsoDate) }),
      response: { 201: View },
    },
  }, async (req, reply) => reply.code(201).send(await one(req, (await svc.publish(app.db, actorOf(req), req.body as never)).id) as never));

  app.patch('/announcements/:id', {
    config: { permission: 'announcements:manage' },
    schema: { params: IdParams, body: Obj({ title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), body: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), severity: Type.Optional(Severity), expiresAt: Type.Optional(Nullable(IsoDate)) }, { minProperties: 1 }), response: { 200: View } },
  }, async (req) => { await svc.update(app.db, actorOf(req), req.params.id, req.body as never); return (await one(req, req.params.id)) as never; });

  app.post('/announcements/:id/retract', { config: { permission: 'announcements:manage' }, schema: { params: IdParams, response: { 204: Type.Null() } } },
    async (req, reply) => { await svc.retract(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });

  // Which roles receive each kind of system alert (default: admin + supervisor).
  const RuleType = lits(ROUTABLE_TYPES as unknown as ['low_stock']);
  app.get('/organization/notification-rules', {
    config: { permission: 'org:read' },
    schema: { response: { 200: Obj({ items: Type.Array(Obj({ type: Type.String(), roles: Type.Array(Type.String()), isDefault: Type.Boolean() })) }) } },
  }, async (req) => ({ items: await getRules(app.db, req.user!.orgId) }));

  app.put('/organization/notification-rules/:type', {
    config: { permission: 'org:manage' },
    schema: { params: Obj({ type: Type.String({ maxLength: 40 }) }), body: Obj({ roles: Type.Array(Roles, { minItems: 1, maxItems: 4 }) }), response: { 204: Type.Null() } },
  }, async (req, reply) => { await setRule(app.db, actorOf(req), req.params.type as NotificationType, req.body.roles); return reply.code(204).send(null); });
  void RuleType;
}
