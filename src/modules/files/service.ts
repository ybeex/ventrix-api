import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { files } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { AppError, NotFoundError, UnauthorizedError, UnprocessableError } from '../../lib/errors.js';
import { hmacHex, safeEqual } from '../../lib/tokens.js';
import { env } from '../../env.js';
import { storage } from './storage.js';

export type FileRow = typeof files.$inferSelect;
export type FileKind = 'item_photo' | 'transaction_snapshot';

/** Content type is decided by the BYTES, never by the client's header or filename. SVG/HTML are deliberately not accepted. */
export function sniffImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

export async function uploadFile(db: Db, actor: Actor, kind: FileKind, body: Buffer): Promise<FileRow> {
  if (body.length === 0) throw new UnprocessableError('EMPTY_FILE', 'The uploaded file is empty');
  if (body.length > env.MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', `Files may be at most ${env.MAX_UPLOAD_BYTES} bytes`);
  const sniffed = sniffImage(body);
  if (!sniffed) throw new UnprocessableError('UNSUPPORTED_FILE_TYPE', 'Only JPEG, PNG or WebP images are accepted');

  const key = `${actor.orgId}/${kind}/${randomUUID()}.${sniffed.ext}`; // server-generated; never derived from client input
  await storage.put(key, body, sniffed.type);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(files).values({
      orgId: actor.orgId, kind, storageKey: key, contentType: sniffed.type, sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'), uploadedBy: actor.id,
    }).returning();
    await audit(tx, actor, { action: 'file.uploaded', entityType: 'file', entityId: row.id, next: { kind, sizeBytes: row.sizeBytes, contentType: row.contentType } });
    return row;
  });
}

/** References from other records (item photo, transaction snapshot) must point at a file of the right kind in THIS org. */
export async function assertFile(db: Db, orgId: string, id: string, kind: FileKind): Promise<FileRow> {
  const [row] = await db.select().from(files).where(and(eq(files.id, id), eq(files.orgId, orgId))).limit(1);
  if (!row || row.kind !== kind) throw new UnprocessableError('FILE_NOT_FOUND', 'File not found (upload it first, with the matching kind)');
  return row;
}

export async function getFile(db: Db, orgId: string, id: string): Promise<FileRow> {
  const [row] = await db.select().from(files).where(and(eq(files.id, id), eq(files.orgId, orgId))).limit(1);
  if (!row) throw new NotFoundError('File');
  return row;
}

const sign = (id: string, exp: number) => hmacHex(`file:${id}:${exp}`, env.FILE_URL_SECRET);

export async function fileLink(file: FileRow): Promise<{ url: string; expiresAt: string }> {
  const ttl = env.FILE_URL_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const direct = await storage.directUrl(file.storageKey, ttl, file.contentType);
  if (direct) return { url: direct, expiresAt: expiresAt.toISOString() };
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return { url: `/v1/files/${file.id}/content?exp=${exp}&sig=${sign(file.id, exp)}`, expiresAt: expiresAt.toISOString() };
}

/** Local driver only: serves bytes for a signed, unexpired URL. The signature binds the file id and expiry. */
export async function readSigned(db: Db, id: string, exp: number, sig: string): Promise<{ body: Buffer; contentType: string }> {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() || !safeEqual(sig, sign(id, exp))) throw new UnauthorizedError('This link is invalid or has expired');
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  if (!row) throw new NotFoundError('File');
  return { body: await storage.get(row.storageKey), contentType: row.contentType };
}
