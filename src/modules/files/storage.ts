/**
 * Object storage behind one interface and one circuit breaker.
 *   local  — dev/test only (disk); production config validation refuses it (does not scale across instances).
 *   s3     — AWS S3, Cloudflare R2, Backblaze B2, MinIO: anything S3-compatible. Buckets must be PRIVATE;
 *            every read goes through a short-lived presigned URL, never a public object URL.
 * When the breaker is open, upload/download endpoints answer 503 immediately and the rest of the API is unaffected.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../env.js';
import { createBreaker } from '../../lib/resilience/circuit.js';

export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** A time-limited direct URL, or null when the driver can't mint one (local → the API serves bytes itself). */
  directUrl(key: string, ttlSeconds: number, contentType: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements StorageDriver {
  private root = resolve(env.STORAGE_LOCAL_DIR);
  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Illegal storage key'); // path-traversal guard (keys are server-generated anyway)
    return full;
  }
  async put(key: string, body: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body, { mode: 0o600 }); }
  async get(key: string) { return readFile(this.path(key)); }
  async directUrl() { return null; }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

class S3Storage implements StorageDriver {
  private client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: !!env.S3_ENDPOINT,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    maxAttempts: 2,
  });
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=0' }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async directUrl(key: string, ttlSeconds: number, contentType: string) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentType: contentType, ResponseContentDisposition: 'inline' }), { expiresIn: ttlSeconds });
  }
  async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key })); }
}

/** A missing object or a bad key is the caller's problem, not evidence the storage backend is unhealthy. */
const ignore = (err: unknown) => {
  const e = err as { code?: string; name?: string };
  return e.code === 'ENOENT' || e.name === 'NoSuchKey' || e.name === 'NotFound';
};

let driver: StorageDriver | null = null;
const raw = () => (driver ??= env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage());

export const storage = {
  put: createBreaker('storage', (k: string, b: Buffer, ct: string) => raw().put(k, b, ct), { ignoreError: ignore }),
  get: createBreaker('storage-read', (k: string) => raw().get(k), { ignoreError: ignore }),
  directUrl: createBreaker('storage-url', (k: string, ttl: number, ct: string) => raw().directUrl(k, ttl, ct)),
  remove: createBreaker('storage-delete', (k: string) => raw().remove(k), { ignoreError: ignore }),
};
