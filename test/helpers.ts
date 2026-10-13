import { sql } from 'drizzle-orm';
import { runMigrations } from '../scripts/migrate.js';
import { buildApp } from '../src/app.js';
import { db } from '../src/db/index.js';
import { env } from '../src/env.js';

export type App = Awaited<ReturnType<typeof buildApp>>;
let migrated = false;

export async function makeApp(): Promise<App> {
  if (!migrated) { await runMigrations(env.DATABASE_URL); migrated = true; }
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Empties every table (not the drizzle migration bookkeeping) and the test Redis DB. */
export async function resetAll(app: App): Promise<void> {
  const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = (Array.isArray(tables) ? tables : (tables as { rows: { tablename: string }[] }).rows).map((t) => `"${t.tablename}"`);
  if (names.length) await db.execute(sql.raw(`truncate ${names.join(', ')} restart identity cascade`));
  await app.redis.flushdb();
}

import { randomUUID } from 'node:crypto';
import { sentMessages } from '../src/modules/mail/mailer.js';
import { dispatchDueEmails } from '../src/modules/mail/outbox.js';

export const PASSWORD = 'Correct-Horse-9-Battery';
export const idem = () => randomUUID();

export interface Session { token: string; userId: string; orgId: string; slug: string; email: string }

export async function registerOrg(app: App, name = 'Acme Works', email = `admin-${randomUUID().slice(0, 8)}@acme.test`): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/register-org', payload: { organizationName: name, email, password: PASSWORD, adminName: 'Ada Admin' } });
  if (res.statusCode !== 201) throw new Error(`register failed ${res.statusCode} ${res.body}`);
  const b = res.json();
  return { token: b.session.token, userId: b.session.user.id, orgId: b.organization.id, slug: b.organization.slug, email };
}

export function call(app: App, token: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url: `/v1${url}`, payload: payload as never, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
}

/** Mutating call with a fresh Idempotency-Key (or the supplied one). */
export const callIdem = (app: App, token: string, method: 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, key = idem()) =>
  call(app, token, method, url, payload, { 'idempotency-key': key });

/** Invite a user as `admin`, deliver the email, accept it, and return the new user's session. */
export async function createUser(app: App, admin: Session, role: 'admin' | 'supervisor' | 'store_staff' | 'viewer', name?: string): Promise<Session> {
  const email = `${role}-${randomUUID().slice(0, 8)}@acme.test`;
  const inv = await callIdem(app, admin.token, 'POST', '/users/invitations', { email, role, name: name ?? `${role} person` });
  if (inv.statusCode !== 201) throw new Error(`invite failed ${inv.statusCode} ${inv.body}`);
  await dispatchDueEmails((await import('../src/db/index.js')).db);
  const msg = [...sentMessages].reverse().find((m) => m.to === email)!;
  const token = /token=([A-Za-z0-9_-]+)/.exec(msg.text)![1];
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token, password: PASSWORD } });
  if (acc.statusCode !== 200) throw new Error(`accept failed ${acc.statusCode} ${acc.body}`);
  return { token: acc.json().token, userId: inv.json().id, orgId: admin.orgId, slug: admin.slug, email };
}

export const lastMailTo = (email: string) => [...sentMessages].reverse().find((m) => m.to === email);
export const tokenFromMail = (email: string) => /token=([A-Za-z0-9_-]+)/.exec(lastMailTo(email)!.text)![1];
/** Drains the outbox completely (dispatchDueEmails sends at most one batch of 20 per call). */
export async function flushMail() { for (let i = 0; i < 50; i++) { const r = await dispatchDueEmails(db); if (r.sent + r.failed + r.deferred === 0) break; } }

/** Minimal valid 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export function multipart(content: Buffer, filename = 'photo.png', contentType = 'image/png') {
  const boundary = '----sk' + randomUUID().replace(/-/g, '');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(app: App, token: string, kind: 'item_photo' | 'transaction_snapshot', content = PNG, filename?: string, contentType?: string) {
  const m = multipart(content, filename, contentType);
  return app.inject({ method: 'POST', url: `/v1/files?kind=${kind}`, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${token}` } });
}

const seeded = new Map<string, { shelfId: string; categoryId: string }>();
/** Every new organization starts with a "Main shelf" and a "General" category; helpers use them unless a test names its own. */
export async function seededCatalog(app: App, token: string) {
  let c = seeded.get(token);
  if (!c) {
    const shelf = (await call(app, token, 'GET', '/shelves')).json().items[0];
    const cat = (await call(app, token, 'GET', '/categories')).json().items.find((x: { name: string }) => x.name === 'General');
    c = { shelfId: shelf.id, categoryId: cat.id };
    seeded.set(token, c);
  }
  return c;
}

export async function mkShelf(app: App, token: string, body: object = { name: `Shelf ${randomUUID().slice(0, 6)}` }) {
  const r = await call(app, token, 'POST', '/shelves', body);
  if (r.statusCode !== 201) throw new Error(`shelf failed ${r.body}`);
  return r.json();
}

export async function mkCategory(app: App, token: string, body: Record<string, unknown> = { name: `Cat ${randomUUID().slice(0, 6)}` }) {
  const shelfId = (body.shelfId as string | undefined) ?? (await seededCatalog(app, token)).shelfId;
  const r = await call(app, token, 'POST', '/categories', { shelfId, ...body });
  if (r.statusCode !== 201) throw new Error(`category failed ${r.body}`);
  return r.json();
}

export async function mkItem(app: App, token: string, body: Record<string, unknown>, key = idem()) {
  const categoryId = (body.categoryId as string | undefined) ?? (await seededCatalog(app, token)).categoryId;
  const r = await callIdem(app, token, 'POST', '/items', { name: `Item ${randomUUID().slice(0, 6)}`, categoryId, ...body }, key);
  if (r.statusCode !== 201 && r.statusCode !== 200) throw new Error(`item failed ${r.statusCode} ${r.body}`);
  return r.json();
}

export async function mkHolder(app: App, token: string, name = `Holder ${randomUUID().slice(0, 6)}`, kind = 'person') {
  const r = await call(app, token, 'POST', '/holders', { kind, name });
  if (r.statusCode !== 201) throw new Error(`holder failed ${r.body}`);
  return r.json();
}

import assert from 'node:assert/strict';
/** Postgres errors surface wrapped (DrizzleQueryError → cause → driver error). Match against the whole chain, like production's pgError(). */
export const dbMessage = (e: unknown): string => {
  const parts: string[] = []; let c: any = e;
  for (let i = 0; c && i < 5; i++) { parts.push(String(c.message)); c = c.cause; }
  return parts.join(' | ');
};
export const rejectsDb = (p: Promise<unknown>, re: RegExp, _why?: string) => assert.rejects(p, (e) => { assert.match(dbMessage(e), re); return true; });

import { and, asc, eq } from 'drizzle-orm';
import { auditEvents } from '../src/db/schema.js';
/** All audit rows for an org (optionally one action), oldest first. */
export async function auditRows(orgId: string, action?: string) {
  return db.select().from(auditEvents)
    .where(action ? and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, action)) : eq(auditEvents.orgId, orgId))
    .orderBy(asc(auditEvents.seq));
}
export const auditCount = async (orgId: string, action?: string) => (await auditRows(orgId, action)).length;
