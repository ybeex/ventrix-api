import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Email, IdParams, Obj, PageOf, PageQuery } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { typed } from '../../types.js';
import { RoleSchema, UserView } from './schemas.js';
import * as users from './users.service.js';
import { clearPin } from './auth.service.js';
import * as sess from './sessions.service.js';

const Serialize = <T extends { createdAt: Date; lastLoginAt: Date | null }>(u: T) =>
  ({ ...u, createdAt: u.createdAt.toISOString(), lastLoginAt: u.lastLoginAt?.toISOString() ?? null });

export default async function usersRoutes(fastify: FastifyInstance) {
  const app = typed(fastify);

  app.get('/users', {
    config: { permission: 'users:manage' },
    schema: { querystring: Obj({ ...PageQuery, role: Type.Optional(RoleSchema), active: Type.Optional(Type.Boolean()) }), response: { 200: PageOf(UserView) } },
  }, async (req) => {
    const page = await users.listUsers(app.db, req.user!.orgId, { ...req.query, limit: req.query.limit ?? 25 });
    return { items: page.items.map(Serialize), nextCursor: page.nextCursor };
  });

  const InviteIn = Obj({ email: Email, role: RoleSchema, name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) });
  const InviteView = Obj({
    id: Type.String(), email: Type.String(), role: RoleSchema, name: Type.Union([Type.String(), Type.Null()]),
    invitedBy: Type.Union([Obj({ id: Type.String(), name: Type.Union([Type.String(), Type.Null()]) }), Type.Null()]),
    invitedAt: Type.Union([Type.String(), Type.Null()]), expiresAt: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.Literal('pending'), Type.Literal('expired'), Type.Literal('revoked')]),
  });

  app.post('/users/invitations', {
    config: { permission: 'users:invite', idempotent: true },
    schema: { body: InviteIn, response: { 201: UserView } },
  }, async (req, reply) => reply.code(201).send(Serialize(await users.inviteUser(app.db, actorOf(req), req.body))));

  app.post('/users/invitations/bulk', {
    config: { permission: 'users:invite', idempotent: true },
    schema: {
      body: Obj({ invites: Type.Array(InviteIn, { minItems: 1, maxItems: 50 }) }),
      response: { 200: Obj({ results: Type.Array(Obj({ email: Type.String(), status: Type.Union([Type.Literal('invited'), Type.Literal('exists'), Type.Literal('forbidden'), Type.Literal('invalid')]), userId: Type.Optional(Type.String()), message: Type.Optional(Type.String()) })) }) },
    },
  }, async (req) => ({ results: await users.inviteMany(app.db, actorOf(req), req.body.invites) }));

  app.get('/users/invitations', {
    config: { permission: 'users:invite' },
    schema: { querystring: Obj({ cursor: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })), status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('expired'), Type.Literal('revoked')])) }), response: { 200: Obj({ items: Type.Array(InviteView), nextCursor: Type.Union([Type.String(), Type.Null()]) }) } },
  }, async (req) => {
    const p = await users.listInvitations(app.db, actorOf(req), { status: req.query.status, cursor: req.query.cursor, limit: req.query.limit ?? 25 });
    return { items: p.items.map((i) => ({ ...i, invitedAt: i.invitedAt?.toISOString() ?? null, expiresAt: i.expiresAt?.toISOString() ?? null })), nextCursor: p.nextCursor };
  });

  app.post('/users/:id/invitations/resend', {
    config: { permission: 'users:invite' },
    schema: { params: IdParams, response: { 204: Type.Null() } },
  }, async (req, reply) => { await users.resendInvite(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });

  app.post('/users/:id/invitations/revoke', {
    config: { permission: 'users:invite' },
    schema: { params: IdParams, response: { 204: Type.Null() } },
  }, async (req, reply) => { await users.revokeInvite(app.db, actorOf(req), req.params.id); return reply.code(204).send(null); });

  app.patch('/users/:id', {
    config: { permission: 'users:manage' },
    schema: { params: IdParams, body: Obj({ role: Type.Optional(RoleSchema), active: Type.Optional(Type.Boolean()) }, { minProperties: 1 }), response: { 200: UserView } },
  }, async (req) => Serialize(await users.updateUser(app.db, app.cache, actorOf(req), req.params.id, req.body)));

  app.get('/users/:id/sessions', {
    config: { permission: 'users:manage' },
    schema: { params: IdParams, response: { 200: Obj({ items: Type.Array(Obj({ id: Type.String(), kind: Type.String(), trustedDevice: Type.Boolean(), deviceId: Type.Union([Type.String(), Type.Null()]), ip: Type.Union([Type.String(), Type.Null()]), userAgent: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(), expiresAt: Type.String(), current: Type.Boolean() })) }) } },
  }, async (req) => ({ items: await sess.listUserSessions(app.db, req.user!.orgId, req.params.id) }));

  app.delete('/users/:id/sessions', {
    config: { permission: 'users:manage' },
    schema: { params: IdParams, response: { 200: Obj({ revoked: Type.Integer() }) } },
  }, async (req) => ({ revoked: await sess.revokeAllSessions(app.db, app.cache, actorOf(req), req.params.id) }));

  app.delete('/users/:id/pin', {
    config: { permission: 'users:manage' },
    schema: { params: IdParams, response: { 204: Type.Null() } },
  }, async (req, reply) => {
    await clearPin(app.db, req.user!.orgId, req.params.id, { id: req.user!.id, requestId: req.id, ip: req.ip });
    return reply.code(204).send(null);
  });
}
