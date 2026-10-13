import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Type } from '@sinclair/typebox';
import { actorOf } from '../../lib/actor.js';
import { AppError, UnprocessableError } from '../../lib/errors.js';
import { IdParams, IsoDate, Nullable, Obj, Uuid, lits } from '../../lib/strict.js';
import { env } from '../../env.js';
import { typed } from '../../types.js';
import { csvStream } from '../reports/csv.js';
import * as svc from './service.js';

const Config = Obj({
  mapping: Obj(Object.fromEntries(svc.FIELDS.map((f) => [f, Type.Optional(Nullable(Type.String({ maxLength: 120 })))]))) as never,
  defaults: Type.Optional(Obj({ type: Type.Optional(lits(['asset', 'consumable'])), unit: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })), categoryId: Type.Optional(Uuid), shelfId: Type.Optional(Uuid) })),
  createCategories: Type.Optional(Type.Boolean()),
});
const Issue = Obj({ row: Type.Integer(), field: Type.Optional(Type.String()), code: Type.String(), message: Type.String(), status: lits(['invalid', 'duplicate']) });
const JobView = Obj({
  id: Uuid, fileName: Type.String(), status: lits(['uploaded', 'ready', 'committing', 'completed', 'failed']), totalRows: Nullable(Type.Integer()),
  importedRows: Nullable(Type.Integer()), skippedRows: Nullable(Type.Integer()), failedRows: Nullable(Type.Integer()), startedAt: IsoDate, completedAt: Nullable(IsoDate),
});
const ser = (j: { id: string; fileName: string; status: never; totalRows: number | null; importedRows: number | null; skippedRows: number | null; failedRows: number | null; startedAt: Date; completedAt: Date | null }) =>
  ({ id: j.id, fileName: j.fileName, status: j.status, totalRows: j.totalRows, importedRows: j.importedRows, skippedRows: j.skippedRows, failedRows: j.failedRows, startedAt: j.startedAt.toISOString(), completedAt: j.completedAt?.toISOString() ?? null });

export default async function importRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: env.MAX_IMPORT_BYTES, files: 1, fields: 2, parts: 3 } });
  const app = typed(fastify);

  app.post('/imports', {
    config: { permission: 'imports:run' },
    schema: { response: { 201: Obj({ import: JobView, headers: Type.Array(Type.String()), suggestedMapping: Type.Record(Type.String(), Type.String()), sample: Type.Array(Type.Array(Type.String())) }) } },
  }, async (req, reply) => {
    const part = await req.file();
    if (!part) throw new UnprocessableError('NO_FILE', 'Attach a CSV file as multipart/form-data');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', `CSV files may be at most ${env.MAX_IMPORT_BYTES} bytes`);
    const { job, suggestedMapping, sample } = await svc.createImport(app.db, actorOf(req), part.filename || 'import.csv', buf);
    return reply.code(201).send({ import: ser(job as never), headers: job.headers as string[], suggestedMapping: suggestedMapping as Record<string, string>, sample });
  });

  app.get('/imports', { config: { permission: 'imports:run' }, schema: { response: { 200: Obj({ items: Type.Array(JobView) }) } } },
    async (req) => ({ items: (await svc.listImports(app.db, req.user!.orgId, 50)).map((j) => ser(j as never)) }));

  app.get('/imports/:id', {
    config: { permission: 'imports:run' },
    schema: { params: IdParams, response: { 200: Obj({ import: JobView, headers: Type.Array(Type.String()), mapping: Type.Any(), issues: Type.Array(Issue) }) } },
  }, async (req) => {
    const j = await svc.getImport(app.db, req.user!.orgId, req.params.id);
    return { import: ser(j as never), headers: (j.headers as string[]) ?? [], mapping: j.columnMapping ?? null, issues: ((j.errorReport as svc.RowIssue[]) ?? []).slice(0, 200) as never };
  });

  app.post('/imports/:id/validate', {
    config: { permission: 'imports:run' },
    schema: { params: IdParams, body: Config, response: { 200: Obj({ import: JobView, summary: Obj({ total: Type.Integer(), valid: Type.Integer(), invalid: Type.Integer(), duplicates: Type.Integer(), issues: Type.Array(Issue), issuesTruncated: Type.Boolean() }) }) } },
  }, async (req) => {
    const { job, summary } = await svc.validateImport(app.db, actorOf(req), req.params.id, req.body as unknown as svc.ImportConfig);
    return { import: ser(job as never), summary: summary as never };
  });

  app.post('/imports/:id/commit', {
    config: { permission: 'imports:run' },
    schema: { params: IdParams, response: { 200: Obj({ import: JobView, result: Nullable(Obj({ imported: Type.Integer(), skipped: Type.Integer(), failed: Type.Integer() })) }), 202: Obj({ import: JobView, result: Nullable(Type.Null()) }) } },
  }, async (req, reply) => {
    const actor = actorOf(req);
    const { inline } = await svc.startCommit(app.db, actor, req.params.id);
    if (!inline) return reply.code(202).send({ import: ser(await svc.getImport(app.db, actor.orgId, req.params.id) as never), result: null });
    const result = await svc.runCommit(app.db, actor, req.params.id);
    return { import: ser(await svc.getImport(app.db, actor.orgId, req.params.id) as never), result };
  });

  app.get('/imports/:id/errors', {
    config: { permission: 'imports:run' },
    schema: { params: IdParams },
  }, async (req, reply) => {
    const j = await svc.getImport(app.db, req.user!.orgId, req.params.id);
    const rows = ((j.errorReport as svc.RowIssue[]) ?? []).map((i) => ({ row: i.row, field: i.field ?? '', status: i.status, code: i.code, message: i.message }));
    async function* one() { yield rows; }
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="import-errors-${j.id}.csv"`)
      .send(csvStream([{ key: 'row', label: 'Row' }, { key: 'field', label: 'Field' }, { key: 'status', label: 'Status' }, { key: 'code', label: 'Code' }, { key: 'message', label: 'Problem' }], one()) as never);
  });
}
