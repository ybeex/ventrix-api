/**
 * CSV import (PRD §22) — a one-time onboarding tool, built so a bad file can never corrupt the catalogue:
 *   upload   parse + store rows (size/row/column caps; formulas are just text here and neutralised on any export)
 *   validate map columns, check every row, flag duplicates (against the file AND existing active items) — no writes
 *   commit   each row is created through the normal createItem path in its OWN transaction with the idempotency key
 *            `import:<id>:<row>`, so a crash/retry/double-click can never create an item twice, one bad row can't
 *            poison the rest, and every created item gets its CREATE ledger row (opening balance included).
 */
import { parse } from 'csv-parse/sync';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, importJobs, items, shelves, users } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { enqueue } from '../../lib/queue.js';
import { assertUsableCategory, createCategory } from '../categories/service.js';
import { assertUsableShelf } from '../shelves/service.js';
import { createItem, type CreateItemInput } from '../items/service.js';
import { env } from '../../env.js';

export const FIELDS = ['name', 'type', 'sku', 'code', 'description', 'category', 'unit', 'quantity', 'minQuantity', 'reorderQuantity', 'expectedReturnHours', 'shelf'] as const;
export type Field = (typeof FIELDS)[number];
export interface ImportConfig {
  mapping: Partial<Record<Field, string | null>>;
  defaults?: { type?: 'asset' | 'consumable'; unit?: string; categoryId?: string; shelfId?: string };
  createCategories?: boolean;
}
// defaults.categoryId: put rows with no category column/value there. defaults.shelfId: shelf for categories created by the import when a row names no shelf.
export interface RowIssue { row: number; field?: string; code: string; message: string; status: 'invalid' | 'duplicate' }

const SYNONYMS: Record<Field, string[]> = {
  name: ['name', 'item', 'item name', 'product', 'product name', 'title'], type: ['type', 'item type', 'kind'], sku: ['sku', 'part number', 'part no', 'part #', 'reference'],
  code: ['code', 'barcode', 'tag', 'asset tag', 'qr'], description: ['description', 'details', 'notes'], category: ['category', 'group', 'department'], unit: ['unit', 'uom', 'unit of measure'],
  quantity: ['quantity', 'qty', 'stock', 'opening quantity', 'on hand', 'opening stock'], minQuantity: ['min', 'minimum', 'min quantity', 'minimum quantity', 'reorder level'],
  reorderQuantity: ['reorder quantity', 'reorder qty', 'order quantity'], expectedReturnHours: ['expected return hours', 'return hours'], shelf: ['shelf', 'rack', 'bay'],
};

export function suggestMapping(headers: string[]): Partial<Record<Field, string>> {
  const norm = (h: string) => h.trim().toLowerCase();
  const out: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) { const hit = headers.find((h) => SYNONYMS[f].includes(norm(h))); if (hit) out[f] = hit; }
  return out;
}

export function parseCsv(buf: Buffer): { headers: string[]; rows: string[][] } {
  if (buf.subarray(0, 4096).includes(0)) throw new UnprocessableError('NOT_CSV', 'This looks like a binary file, not a CSV');
  let records: string[][];
  try {
    records = parse(buf, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: false, max_record_size: 100_000, columns: false });
  } catch (err) {
    throw new UnprocessableError('INVALID_CSV', `The CSV could not be read: ${(err as Error).message.slice(0, 200)}`);
  }
  if (records.length < 2) throw new UnprocessableError('EMPTY_CSV', 'The file needs a header row and at least one data row');
  const [headers, ...rows] = records;
  if (headers.length > 60) throw new UnprocessableError('TOO_MANY_COLUMNS', 'At most 60 columns are supported');
  if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length || headers.some((h) => !h)) throw new UnprocessableError('BAD_HEADERS', 'Header names must be unique and non-empty');
  if (rows.length > env.MAX_IMPORT_ROWS) throw new UnprocessableError('TOO_MANY_ROWS', `At most ${env.MAX_IMPORT_ROWS} rows per import; split the file`);
  return { headers, rows };
}

export async function createImport(db: Db, actor: Actor, fileName: string, buf: Buffer) {
  const { headers, rows } = parseCsv(buf);
  return db.transaction(async (tx) => {
    const [job] = await tx.insert(importJobs).values({ orgId: actor.orgId, fileName: fileName.slice(0, 200), headers, rows, totalRows: rows.length, startedBy: actor.id }).returning();
    await audit(tx, actor, { action: 'import.uploaded', entityType: 'import', entityId: job.id, next: { fileName: job.fileName, rows: rows.length } });
    return { job, suggestedMapping: suggestMapping(headers), sample: rows.slice(0, 5) };
  });
}

interface Parsed { input: Omit<CreateItemInput, 'categoryId'>; categoryName: string | null; shelfName: string | null }

/** Row → item input, or the reasons it can't be. Pure (no I/O) so validate and commit can never disagree about a row. */
export function parseRow(raw: string[], headers: string[], cfg: ImportConfig, rowNo: number): { parsed?: Parsed; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const bad = (field: string, code: string, message: string) => issues.push({ row: rowNo, field, code, message, status: 'invalid' });
  const cell = (f: Field): string => { const h = cfg.mapping[f]; if (!h) return ''; const i = headers.indexOf(h); return i < 0 ? '' : (raw[i] ?? '').trim(); };
  const int = (f: Field, min: number, max = 10_000_000): number | undefined => {
    const v = cell(f); if (v === '') return undefined;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) { bad(f, 'INVALID_NUMBER', `"${v}" must be a whole number between ${min} and ${max}`); return undefined; }
    return Number(v);
  };

  const name = cell('name');
  if (!name) bad('name', 'NAME_REQUIRED', 'Name is required'); else if (name.length > 160) bad('name', 'NAME_TOO_LONG', 'Name is longer than 160 characters');
  const typeRaw = cell('type').toLowerCase() || cfg.defaults?.type;
  const type = typeRaw === 'asset' || typeRaw === 'tool' ? 'asset' : typeRaw === 'consumable' || typeRaw === 'stock' ? 'consumable' : undefined;
  if (!type) bad('type', 'TYPE_REQUIRED', typeRaw ? `Unknown type "${typeRaw}" (use asset or consumable)` : 'Type is required (map a column or set a default)');
  if (!cell('category') && !cfg.defaults?.categoryId) bad('category', 'CATEGORY_REQUIRED', 'Every item needs a category (map a category column or choose a default category)');
  const sku = cell('sku'); if (sku.length > 80) bad('sku', 'SKU_TOO_LONG', 'SKU is longer than 80 characters');
  const code = cell('code'); if (code && !/^[A-Za-z0-9._-]{1,80}$/.test(code)) bad('code', 'INVALID_CODE', 'Codes may contain letters, digits, . _ - only');
  const quantity = int('quantity', 0), min = int('minQuantity', 0), reorder = int('reorderQuantity', 0), hours = int('expectedReturnHours', 1, 8760);
  if (type === 'asset') {
    if (quantity !== undefined && quantity > 1) bad('quantity', 'ASSET_QUANTITY', 'A tracked asset is a single unit; list each asset on its own row');
    if (min !== undefined || reorder !== undefined) bad('minQuantity', 'NOT_APPLICABLE', 'Minimum/reorder levels apply to consumables only');
  }
  if (type === 'consumable' && hours !== undefined) bad('expectedReturnHours', 'NOT_APPLICABLE', 'Expected return hours apply to assets only');
  if (issues.length) return { issues };
  return {
    issues,
    parsed: {
      categoryName: cell('category') || null, shelfName: cell('shelf') || null,
      input: {
        type: type!, name, description: cell('description') || undefined, sku: sku || undefined, code: code || undefined, unit: cell('unit') || cfg.defaults?.unit || undefined,
        ...(type === 'consumable' ? { openingQuantity: quantity ?? 0, minQuantity: min, reorderQuantity: reorder } : { expectedReturnHours: hours }),
      },
    },
  };
}

async function lookups(db: Db, orgId: string) {
  const cats = await db.select({ id: categories.id, name: categories.name }).from(categories).where(and(eq(categories.orgId, orgId), isNull(categories.archivedAt)));
  const shs = await db.select({ id: shelves.id, name: shelves.name }).from(shelves).where(and(eq(shelves.orgId, orgId), isNull(shelves.archivedAt)));
  return { cats: new Map(cats.map((c) => [c.name.toLowerCase(), c.id])), shelfByName: new Map(shs.map((x) => [x.name.toLowerCase(), x.id])) };
}

async function existing(db: Db, orgId: string, skus: string[], codes: string[]) {
  const skuSet = new Set<string>(); const codeSet = new Set<string>();
  for (let i = 0; i < skus.length; i += 1000) for (const r of await db.select({ s: items.sku }).from(items).where(and(eq(items.orgId, orgId), isNull(items.archivedAt), inArray(items.sku, skus.slice(i, i + 1000))))) if (r.s) skuSet.add(r.s);
  for (let i = 0; i < codes.length; i += 1000) for (const r of await db.select({ c: items.code }).from(items).where(and(eq(items.orgId, orgId), isNull(items.archivedAt), inArray(items.code, codes.slice(i, i + 1000))))) codeSet.add(r.c);
  return { skuSet, codeSet };
}

async function loadJob(db: Db, orgId: string, id: string) {
  const [job] = await db.select().from(importJobs).where(and(eq(importJobs.id, id), eq(importJobs.orgId, orgId))).limit(1);
  if (!job) throw new NotFoundError('Import');
  return job;
}

/** Validation preview: nothing is written except the mapping and the error report. */
export async function validateImport(db: Db, actor: Actor, id: string, cfg: ImportConfig) {
  const job = await loadJob(db, actor.orgId, id);
  if (job.status !== 'uploaded' && job.status !== 'ready') throw new ConflictError('IMPORT_NOT_EDITABLE', `This import is ${job.status}`);
  const headers = job.headers as string[]; const rows = job.rows as string[][];
  for (const [field, h] of Object.entries(cfg.mapping)) if (h && !headers.includes(h)) throw new UnprocessableError('UNKNOWN_COLUMN', `Mapped column "${h}" (for ${field}) is not in the file`);
  if (!cfg.mapping.name) throw new UnprocessableError('NAME_NOT_MAPPED', 'Map a column to "name"');
  if (!cfg.mapping.type && !cfg.defaults?.type) throw new UnprocessableError('TYPE_NOT_MAPPED', 'Map a column to "type" or choose a default type');

  const { cats, shelfByName } = await lookups(db, actor.orgId);
  if (cfg.defaults?.categoryId) await assertUsableCategory(db, actor.orgId, cfg.defaults.categoryId);
  if (cfg.defaults?.shelfId) await assertUsableShelf(db, actor.orgId, cfg.defaults.shelfId);
  const shelfFor = (p: Parsed) => (p.shelfName ? shelfByName.get(p.shelfName.toLowerCase()) : cfg.defaults?.shelfId);
  const issues: RowIssue[] = []; const parsed: Array<{ rowNo: number; p: Parsed }> = [];
  rows.forEach((r, i) => { const out = parseRow(r, headers, cfg, i + 2); issues.push(...out.issues); if (out.parsed) parsed.push({ rowNo: i + 2, p: out.parsed }); });

  const ex = await existing(db, actor.orgId, parsed.map((x) => x.p.input.sku).filter(Boolean) as string[], parsed.map((x) => x.p.input.code).filter(Boolean) as string[]);
  const seenSku = new Map<string, number>(); const seenCode = new Map<string, number>();
  let valid = 0;
  for (const { rowNo, p } of parsed) {
    const row: RowIssue[] = [];
    if (p.categoryName && !cats.has(p.categoryName.toLowerCase())) {
      if (!cfg.createCategories) row.push({ row: rowNo, field: 'category', code: 'UNKNOWN_CATEGORY', message: `Category "${p.categoryName}" does not exist (enable "create missing categories" or fix the file)`, status: 'invalid' });
      else if (!p.shelfName && !cfg.defaults?.shelfId) row.push({ row: rowNo, field: 'shelf', code: 'SHELF_REQUIRED', message: `Category "${p.categoryName}" would be created but has no shelf: name an existing shelf in the row or choose a default shelf`, status: 'invalid' });
    }
    if (p.shelfName && !shelfByName.has(p.shelfName.toLowerCase())) row.push({ row: rowNo, field: 'shelf', code: 'UNKNOWN_SHELF', message: `Shelf "${p.shelfName}" does not exist`, status: 'invalid' });
    const sku = p.input.sku; const code = p.input.code;
    if (sku && ex.skuSet.has(sku)) row.push({ row: rowNo, field: 'sku', code: 'DUPLICATE_SKU', message: `An active item already uses SKU "${sku}"`, status: 'duplicate' });
    else if (sku && seenSku.has(sku)) row.push({ row: rowNo, field: 'sku', code: 'DUPLICATE_IN_FILE', message: `SKU "${sku}" already appears on row ${seenSku.get(sku)}`, status: 'duplicate' });
    if (code && ex.codeSet.has(code)) row.push({ row: rowNo, field: 'code', code: 'DUPLICATE_CODE', message: `An active item already uses code "${code}"`, status: 'duplicate' });
    else if (code && seenCode.has(code)) row.push({ row: rowNo, field: 'code', code: 'DUPLICATE_IN_FILE', message: `Code "${code}" already appears on row ${seenCode.get(code)}`, status: 'duplicate' });
    if (row.length === 0) { valid++; if (sku) seenSku.set(sku, rowNo); if (code) seenCode.set(code, rowNo); } else issues.push(...row);
  }
  const invalidRows = new Set(issues.filter((i) => i.status === 'invalid').map((i) => i.row)).size;
  const duplicateRows = new Set(issues.filter((i) => i.status === 'duplicate').map((i) => i.row)).size;
  const [updated] = await db.update(importJobs).set({ columnMapping: cfg, status: 'ready', errorReport: issues.slice(0, 5000), skippedRows: duplicateRows, failedRows: invalidRows, importedRows: 0 }).where(eq(importJobs.id, id)).returning();
  await audit(db, actor, { action: 'import.validated', entityType: 'import', entityId: id, next: { total: rows.length, valid, invalid: invalidRows, duplicates: duplicateRows } });
  return { job: updated, summary: { total: rows.length, valid, invalid: invalidRows, duplicates: duplicateRows, issues: issues.slice(0, 200), issuesTruncated: issues.length > 200 } };
}

export async function startCommit(db: Db, actor: Actor, id: string): Promise<{ inline: boolean }> {
  const job = await loadJob(db, actor.orgId, id);
  if (job.status === 'completed') throw new ConflictError('IMPORT_COMPLETED', 'This import has already been completed');
  if (job.status === 'committing') throw new ConflictError('IMPORT_IN_PROGRESS', 'This import is already running');
  if (job.status !== 'ready' && job.status !== 'failed') throw new ConflictError('IMPORT_NOT_VALIDATED', 'Validate the import (with a column mapping) before committing');
  // Compare-and-set: exactly one caller wins the right to run the commit.
  const [claimed] = await db.update(importJobs).set({ status: 'committing' }).where(and(eq(importJobs.id, id), eq(importJobs.orgId, actor.orgId), inArray(importJobs.status, ['ready', 'failed']))).returning({ id: importJobs.id });
  if (!claimed) throw new ConflictError('IMPORT_IN_PROGRESS', 'This import is already running');
  const inline = (job.totalRows ?? 0) <= env.INLINE_IMPORT_MAX_ROWS;
  if (!inline) {
    try { await enqueue('imports', 'commit', { importId: id, orgId: actor.orgId, userId: actor.id }, `import-${id}-${Date.now()}`); }
    catch (err) { await db.update(importJobs).set({ status: 'ready' }).where(eq(importJobs.id, id)); throw err; } // queue down → back to ready, caller sees 503
  }
  return { inline };
}

/** Runs the commit. Safe to call repeatedly (worker retry, crash recovery): rows already created are recognised by key and skipped. */
export async function runCommit(db: Db, actor: Actor, id: string) {
  const job = await loadJob(db, actor.orgId, id);
  const cfg = job.columnMapping as ImportConfig; const headers = job.headers as string[]; const rows = job.rows as string[][];
  const { cats, shelfByName } = await lookups(db, actor.orgId);
  const issues: RowIssue[] = []; let imported = 0; let skipped = 0; let failed = 0;
  try {
    if (cfg.createCategories) {
      for (const r of rows) {
        const p = parseRow(r, headers, cfg, 0).parsed;
        if (!p?.categoryName || cats.has(p.categoryName.toLowerCase())) continue;
        const shelfId = p.shelfName ? shelfByName.get(p.shelfName.toLowerCase()) : cfg.defaults?.shelfId;
        if (!shelfId) continue; // those rows fail below with a precise reason
        const made = await createCategory(db, actor, { name: p.categoryName, shelfId }).catch(async () => (await lookups(db, actor.orgId)).cats.get(p.categoryName!.toLowerCase()));
        cats.set(p.categoryName.toLowerCase(), typeof made === 'string' ? made : made!.id);
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const rowNo = i + 2;
      const { parsed, issues: bad } = parseRow(rows[i], headers, cfg, rowNo);
      if (!parsed) { failed++; issues.push(...bad); continue; }
      const categoryId = parsed.categoryName ? cats.get(parsed.categoryName.toLowerCase()) : cfg.defaults?.categoryId;
      if (!categoryId) { failed++; issues.push({ row: rowNo, field: 'category', code: 'UNKNOWN_REFERENCE', message: 'Category (or the shelf it would be created on) not found', status: 'invalid' }); continue; }
      try {
        await createItem(db, actor, { ...parsed.input, categoryId }, `import:${id}:${rowNo}`);
        imported++;
      } catch (err) {
        if (err instanceof ConflictError && (err.code === 'SKU_TAKEN' || err.code === 'CODE_TAKEN')) { skipped++; issues.push({ row: rowNo, code: err.code, message: err.message, status: 'duplicate' }); }
        else if (err instanceof AppError && err.statusCode < 500) { failed++; issues.push({ row: rowNo, code: err.code, message: err.message, status: 'invalid' }); }
        else throw err; // infrastructure failure: abort so the job is retried; per-row keys make the retry safe
      }
      if ((i + 1) % 100 === 0) await db.update(importJobs).set({ importedRows: imported, skippedRows: skipped, failedRows: failed }).where(eq(importJobs.id, id));
    }
    await db.transaction(async (tx) => {
      await tx.update(importJobs).set({ status: 'completed', importedRows: imported, skippedRows: skipped, failedRows: failed, errorReport: issues.slice(0, 5000), completedAt: new Date() }).where(eq(importJobs.id, id));
      await audit(tx, actor, { action: 'import.committed', entityType: 'import', entityId: id, next: { imported, skipped, failed } });
    });
    return { imported, skipped, failed };
  } catch (err) {
    await db.update(importJobs).set({ status: 'failed', importedRows: imported, skippedRows: skipped, failedRows: failed }).where(eq(importJobs.id, id));
    throw err;
  }
}

export async function loadActor(db: Db, orgId: string, userId: string): Promise<Actor> {
  const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, orgId), eq(users.active, true))).limit(1);
  if (!u) throw new NotFoundError('User');
  return { id: u.id, orgId: u.orgId, role: u.role };
}

export async function getImport(db: Db, orgId: string, id: string) { return loadJob(db, orgId, id); }

export async function listImports(db: Db, orgId: string, limit: number) {
  return db.select({ id: importJobs.id, fileName: importJobs.fileName, status: importJobs.status, totalRows: importJobs.totalRows, importedRows: importJobs.importedRows, skippedRows: importJobs.skippedRows, failedRows: importJobs.failedRows, startedAt: importJobs.startedAt, completedAt: importJobs.completedAt })
    .from(importJobs).where(eq(importJobs.orgId, orgId)).orderBy(desc(importJobs.startedAt)).limit(limit);
}
void sql;
