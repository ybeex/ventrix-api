import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import { organizations, organizationSettings, users } from '../../db/schema.js';
import { Email, Obj, Password, Uuid, Nullable, IsoDate } from '../../lib/strict.js';
import { hashToken } from '../../lib/tokens.js';
import { NotFoundError } from '../../lib/errors.js';
import { authRouteRateLimit } from '../../plugins/security.js';
import { bearerOf } from '../../plugins/auth.js';
import { typed } from '../../types.js';
import { actorOf } from '../../lib/actor.js';
import { OrgSlug, RoleSchema, SessionResponse } from './schemas.js';
import * as svc from './auth.service.js';
import * as sess from './sessions.service.js';

const Pin = Type.String({ pattern: '^[0-9]{4,8}$' });
const DeviceId = Type.String({ minLength: 4, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' });

export default async function authRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);
  const meta = (req: { ip: string; id: string; headers: Record<string, unknown> }) =>
    ({ ip: req.ip, requestId: req.id, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined });
  const sessionBody = (user: { id: string; email: string; role: 'admin' | 'supervisor' | 'store_staff' | 'viewer'; orgId: string }, s: { token: string; expiresAt: Date }) =>
    ({ token: s.token, expiresAt: s.expiresAt.toISOString(), user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId } });

  app.post('/auth/register-org', {
    config: { public: true, ...authRouteRateLimit },
    schema: {
      body: Obj({
        organizationName: Type.String({ minLength: 2, maxLength: 120 }), slug: Type.Optional(OrgSlug),
        timezone: Type.Optional(Type.String({ maxLength: 60 })), adminName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        email: Email, password: Password, deviceId: Type.Optional(DeviceId),
      }),
      response: { 201: Obj({ session: SessionResponse, organization: Obj({ id: Uuid, name: Type.String(), slug: Type.String(), timezone: Type.String() }) }) },
    },
  }, async (req, reply) => {
    const { org, user, session } = await svc.registerOrganization(app.db, req.body, meta(req));
    return reply.code(201).send({ session: sessionBody(user, session), organization: { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone } });
  });

  app.post('/auth/login', {
    config: { public: true, ...authRouteRateLimit },
    schema: {
      body: Obj({ orgSlug: OrgSlug, email: Email, password: Type.String({ minLength: 1, maxLength: 128 }), deviceId: Type.Optional(DeviceId), trustDevice: Type.Optional(Type.Boolean()) }),
      response: { 200: SessionResponse },
    },
  }, async (req) => {
    const { user, session } = await svc.login(app.db, { ...req.body, deviceId: req.body.deviceId ?? (req.headers['x-device-id'] as string | undefined) }, meta(req));
    return sessionBody(user, session);
  });

  app.post('/auth/accept-invite', {
    config: { public: true, ...authRouteRateLimit },
    schema: { body: Obj({ token: Type.String({ minLength: 20, maxLength: 200 }), password: Password, deviceId: Type.Optional(DeviceId) }), response: { 200: SessionResponse } },
  }, async (req) => {
    const { user, session } = await svc.acceptInvite(app.db, req.body, meta(req));
    return sessionBody(user, session);
  });

  app.post('/auth/password-reset/request', {
    config: { public: true, ...authRouteRateLimit },
    schema: { body: Obj({ orgSlug: OrgSlug, email: Email }), response: { 202: Obj({ status: Type.Literal('accepted') }) } },
  }, async (req, reply) => {
    await svc.requestPasswordReset(app.db, req.body, meta(req));
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post('/auth/password-reset/confirm', {
    config: { public: true, ...authRouteRateLimit },
    schema: { body: Obj({ token: Type.String({ minLength: 20, maxLength: 200 }), password: Password }), response: { 204: Type.Null() } },
  }, async (req, reply) => {
    await svc.confirmPasswordReset(app.db, app.cache, req.body, meta(req));
    return reply.code(204).send(null);
  });

  app.post('/auth/logout', { config: { permission: 'session:own' }, schema: { response: { 204: Type.Null() } } }, async (req, reply) => {
    await svc.logout(app.db, app.cache, actorOf(req), hashToken(bearerOf(req)!), req.user!.sessionId);
    return reply.code(204).send(null);
  });

  app.post('/auth/logout-all', { config: { permission: 'session:own' }, schema: { response: { 204: Type.Null() } } }, async (req, reply) => {
    await svc.logoutAll(app.db, app.cache, actorOf(req));
    return reply.code(204).send(null);
  });

  app.get('/auth/me', {
    config: { permission: 'session:own' },
    schema: {
      response: { 200: Obj({
        id: Uuid, email: Type.String(), role: RoleSchema, orgId: Uuid, sessionKind: Type.Union([Type.Literal('primary'), Type.Literal('pin')]),
        trustedDevice: Type.Boolean(), hasPin: Type.Boolean(),
        organization: Obj({ name: Type.String(), slug: Type.String(), timezone: Type.String() }),
        settings: Obj({ staffCanManageItems: Type.Boolean(), requirePhotoFor: Type.Array(Type.String()) }),
      }) },
    },
  }, async (req) => {
    const u = req.user!;
    const [row] = await app.db.select({ email: users.email, hasPin: users.pinHash, name: organizations.name, slug: organizations.slug, tz: organizations.timezone, staff: organizationSettings.staffCanManageItems, photos: organizationSettings.requirePhotoFor })
      .from(users).innerJoin(organizations, eq(organizations.id, users.orgId)).innerJoin(organizationSettings, eq(organizationSettings.orgId, users.orgId)).where(eq(users.id, u.id)).limit(1);
    if (!row) throw new NotFoundError('User');
    return {
      id: u.id, email: row.email, role: u.role, orgId: u.orgId, sessionKind: u.kind, trustedDevice: u.trustedDevice, hasPin: row.hasPin !== null,
      organization: { name: row.name, slug: row.slug, timezone: row.tz }, settings: { staffCanManageItems: row.staff, requirePhotoFor: row.photos },
    };
  });

  const SessionRow = Obj({ id: Uuid, kind: Type.Union([Type.Literal('primary'), Type.Literal('pin')]), trustedDevice: Type.Boolean(), deviceId: Nullable(Type.String()), ip: Nullable(Type.String()), userAgent: Nullable(Type.String()), createdAt: IsoDate, expiresAt: IsoDate, current: Type.Boolean() });
  app.get('/auth/sessions', { config: { permission: 'session:own' }, schema: { response: { 200: Obj({ items: Type.Array(SessionRow) }) } } },
    async (req) => ({ items: await sess.listSessions(app.db, req.user!.id, req.user!.sessionId) }));
  app.delete('/auth/sessions/:id', { config: { permission: 'session:own' }, schema: { params: Obj({ id: Uuid }), response: { 204: Type.Null() } } },
    async (req, reply) => { await sess.revokeSession(app.db, app.cache, actorOf(req), req.user!.id, req.params.id); return reply.code(204).send(null); });

  app.put('/auth/pin', {
    config: { permission: 'session:own', ...authRouteRateLimit },
    schema: { body: Obj({ password: Type.String({ minLength: 1, maxLength: 128 }), pin: Pin }), response: { 204: Type.Null() } },
  }, async (req, reply) => {
    await svc.changeOwnPin(app.db, req.user!.id, req.body, { orgId: req.user!.orgId, ...meta(req) });
    return reply.code(204).send(null);
  });

  app.delete('/auth/pin', { config: { permission: 'session:own' }, schema: { response: { 204: Type.Null() } } }, async (req, reply) => {
    await svc.clearPin(app.db, req.user!.orgId, req.user!.id, { id: req.user!.id, requestId: req.id, ip: req.ip });
    return reply.code(204).send(null);
  });

  app.get('/auth/pin-users', {
    config: { permission: 'session:own' },
    schema: { response: { 200: Obj({ items: Type.Array(Obj({ userId: Uuid, name: Type.String() })) }) } },
  }, async (req) => {
    if (req.user!.kind !== 'primary' || !req.user!.trustedDevice) return { items: [] }; // only registered shared devices see the roster
    return { items: await svc.listPinUsers(app.db, req.user!.orgId) };
  });

  app.post('/auth/pin-switch', {
    config: { permission: 'session:own', ...authRouteRateLimit },
    schema: { body: Obj({ userId: Uuid, pin: Pin }), response: { 200: SessionResponse } },
  }, async (req) => {
    const u = req.user!;
    const { user, session } = await svc.pinSwitch(app.db, { sessionId: u.sessionId, orgId: u.orgId, trustedDevice: u.trustedDevice, kind: u.kind, deviceId: u.deviceId }, req.body, meta(req));
    return sessionBody(user, session);
  });

  void actorOf; void Nullable; void IsoDate;
}
