import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from '@sinclair/typebox';
import { IdParams, IsoDate, Obj, Uuid, lits } from '../../lib/strict.js';
import { actorOf } from '../../lib/actor.js';
import { AppError, UnprocessableError } from '../../lib/errors.js';
import { env } from '../../env.js';
import { typed } from '../../types.js';
import * as svc from './service.js';

const Kind = lits(['item_photo', 'transaction_snapshot']);
const View = Obj({ id: Uuid, kind: Kind, contentType: Type.String(), sizeBytes: Type.Integer(), createdAt: IsoDate });
const ser = (f: svc.FileRow) => ({ id: f.id, kind: f.kind, contentType: f.contentType, sizeBytes: f.sizeBytes, createdAt: f.createdAt.toISOString() });

export default async function fileRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3 } });
  const app = typed(fastify);

  // multipart bodies can't be described by a JSON schema, so `kind` travels in the query string.
  app.post('/files', {
    config: { permission: 'files:write' },
    schema: { querystring: Obj({ kind: Kind }), response: { 201: View } },
  }, async (req, reply) => {
    const part = await req.file();
    if (!part) throw new UnprocessableError('NO_FILE', 'Attach one image as multipart/form-data');
    const body = await part.toBuffer();
    if (part.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', `Files may be at most ${env.MAX_UPLOAD_BYTES} bytes`);
    return reply.code(201).send(ser(await svc.uploadFile(app.db, actorOf(req), req.query.kind, body)));
  });

  app.get('/files/:id', {
    config: { permission: 'files:read' },
    schema: { params: IdParams, response: { 200: Obj({ file: View, url: Type.String(), expiresAt: IsoDate }) } },
  }, async (req) => {
    const file = await svc.getFile(app.db, req.user!.orgId, req.params.id);
    return { file: ser(file), ...(await svc.fileLink(file)) };
  });

  // Local driver only. Authorised by an HMAC-signed, expiring URL minted by GET /files/:id — not by a bearer token,
  // so an <img src> works — and locked down so a served file can never execute as a page.
  app.get('/files/:id/content', {
    config: { public: true },
    schema: { params: IdParams, querystring: Obj({ exp: Type.Integer(), sig: Type.String({ minLength: 64, maxLength: 64 }) }) },
  }, async (req, reply) => {
    const { body, contentType } = await svc.readSigned(app.db, req.params.id, req.query.exp, req.query.sig);
    return reply.header('content-type', contentType).header('content-security-policy', "default-src 'none'; sandbox")
      .header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=60').send(body);
  });
}
