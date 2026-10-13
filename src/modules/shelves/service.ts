/**
 * Shelves (the store's physical structure). A shelf lives in a location and holds categories; categories hold items.
 * Shelves and categories are created SEPARATELY (a category needs an existing shelf; a shelf may start empty).
 * Moving things re-derives location: when a category changes shelf (or a shelf changes location) the affected items'
 * `location_id` is updated in the SAME transaction, so an item's location can never disagree with its shelf.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, items, shelves } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { nextCounterValue } from '../../lib/counters.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { toDate } from '../../lib/sql.js';
import { assertLocation, defaultLocation } from '../locations/service.js';

export type ShelfRow = typeof shelves.$inferSelect;
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

export async function assertUsableShelf(db: Db, orgId: string, id: string): Promise<ShelfRow> {
  const [row] = await db.select().from(shelves).where(and(eq(shelves.id, id), eq(shelves.orgId, orgId))).limit(1);
  if (!row) throw new UnprocessableError('SHELF_NOT_FOUND', 'Shelf not found');
  if (row.archivedAt) throw new UnprocessableError('SHELF_ARCHIVED', 'This shelf is archived');
  return row;
}

const conflict = (err: unknown): never => {
  if (isUniqueViolation(err, 'shelves_org_name_unique')) throw new ConflictError('SHELF_NAME_TAKEN', 'A shelf with this name already exists');
  if (isUniqueViolation(err, 'shelves_org_code_unique')) throw new ConflictError('SHELF_CODE_TAKEN', 'A shelf with this code already exists');
  throw err;
};
const shelfCode = (n: number) => `SHF-${String(n).padStart(4, '0')}`;

/** Every new organization starts with one shelf and one category so the first item can be created immediately. */
export async function seedDefaultCatalog(tx: Db, orgId: string, locationId: string) {
  const [shelf] = await tx.insert(shelves).values({ orgId, locationId, name: 'Main shelf', code: shelfCode(await nextCounterValue(tx, orgId, 'SHF')) }).returning();
  const [category] = await tx.insert(categories).values({ orgId, shelfId: shelf.id, name: 'General' }).returning();
  return { shelf, category };
}

export interface ShelfInput { name: string; locationId?: string; description?: string; code?: string; position?: number; cycleCountDays?: number | null }

export async function createShelf(db: Db, actor: Actor, input: ShelfInput) {
  try {
    return await db.transaction(async (tx) => {
      const location = input.locationId ? await assertLocation(tx, actor.orgId, input.locationId) : await defaultLocation(tx, actor.orgId);
      if (location.archivedAt) throw new UnprocessableError('LOCATION_NOT_FOUND', 'Location not found or archived');
      const code = input.code?.trim() || shelfCode(await nextCounterValue(tx, actor.orgId, 'SHF'));
      const [row] = await tx.insert(shelves).values({
        orgId: actor.orgId, locationId: location.id, name: input.name.trim(), code, description: input.description ?? null, position: input.position ?? 0, cycleCountDays: input.cycleCountDays ?? null,
      }).returning();
      await audit(tx, actor, { action: 'shelf.created', entityType: 'shelf', entityId: row.id, next: { name: row.name, code: row.code, locationId: row.locationId } });
      return row;
    });
  } catch (err) { return conflict(err); }
}

export interface ShelfListRow extends ShelfRow { categoryCount: number; itemCount: number; lastCountedAt: Date | null; nextCountDueAt: Date | null }

export async function listShelves(db: Db, orgId: string, q: { includeArchived?: boolean; locationId?: string }): Promise<ShelfListRow[]> {
  const rows = rowsOf<Record<string, any>>(await db.execute(sql`
    select s.*,
      (select count(*)::int from categories c where c.shelf_id = s.id and c.archived_at is null) as category_count,
      (select count(*)::int from items i join categories c on c.id = i.category_id where c.shelf_id = s.id and i.archived_at is null) as item_count,
      (select max(r.closed_at) from reconciliations r where r.org_id = s.org_id and r.scope = 'shelf' and r.scope_id = s.id and r.status = 'closed') as last_counted_at
    from shelves s
    where s.org_id = ${orgId} ${q.includeArchived ? sql`` : sql`and s.archived_at is null`} ${q.locationId ? sql`and s.location_id = ${q.locationId}` : sql``}
    order by s.position, s.name`));
  return rows.map((r) => {
    const last = toDate(r.last_counted_at);
    const base = last ?? toDate(r.created_at)!;
    return {
    lastCountedAt: last, nextCountDueAt: r.cycle_count_days ? new Date(base.getTime() + r.cycle_count_days * 86_400_000) : null,
    id: r.id, orgId: r.org_id, locationId: r.location_id, name: r.name, code: r.code, description: r.description, position: r.position, cycleCountDays: r.cycle_count_days,
    archivedAt: toDate(r.archived_at), createdAt: toDate(r.created_at)!, updatedAt: toDate(r.updated_at)!, categoryCount: r.category_count, itemCount: r.item_count,
    };
  });
}

export async function getShelf(db: Db, orgId: string, id: string): Promise<ShelfListRow> {
  const found = (await listShelves(db, orgId, { includeArchived: true })).find((s) => s.id === id);
  if (!found) throw new NotFoundError('Shelf');
  return found;
}

export async function lookupShelf(db: Db, orgId: string, code: string): Promise<ShelfListRow> {
  const [row] = await db.select({ id: shelves.id }).from(shelves).where(and(eq(shelves.orgId, orgId), sql`upper(${shelves.code}) = upper(${code.trim()})`)).limit(1);
  if (!row) throw new NotFoundError('Shelf');
  return getShelf(db, orgId, row.id);
}

export async function updateShelf(db: Db, actor: Actor, id: string, patch: Partial<ShelfInput>) {
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(shelves).where(and(eq(shelves.id, id), eq(shelves.orgId, actor.orgId))).for('update');
      if (!before) throw new NotFoundError('Shelf');
      if (before.archivedAt) throw new ConflictError('SHELF_ARCHIVED', 'Restore this shelf before editing it');
      const set: Partial<typeof shelves.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) set.name = patch.name.trim();
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.code !== undefined) set.code = patch.code.trim();
      if (patch.position !== undefined) set.position = patch.position;
      if (patch.cycleCountDays !== undefined) set.cycleCountDays = patch.cycleCountDays;
      let relocated = 0;
      if (patch.locationId !== undefined && patch.locationId !== before.locationId) {
        const loc = await assertLocation(tx, actor.orgId, patch.locationId);
        if (loc.archivedAt) throw new UnprocessableError('LOCATION_NOT_FOUND', 'Location not found or archived');
        set.locationId = loc.id;
        // The whole shelf moves: every item under it follows (location is derived from the shelf).
        relocated = (await tx.update(items).set({ locationId: loc.id, updatedAt: new Date(), updatedBy: actor.id })
          .where(and(eq(items.orgId, actor.orgId), sql`${items.categoryId} in (select id from categories where shelf_id = ${id})`)).returning({ id: items.id })).length;
      }
      const [after] = await tx.update(shelves).set(set).where(eq(shelves.id, id)).returning();
      await audit(tx, actor, {
        action: 'shelf.updated', entityType: 'shelf', entityId: id,
        previous: { name: before.name, code: before.code, description: before.description, position: before.position, cycleCountDays: before.cycleCountDays, locationId: before.locationId },
        next: { name: after.name, code: after.code, description: after.description, position: after.position, cycleCountDays: after.cycleCountDays, locationId: after.locationId, itemsRelocated: relocated },
      });
      return after;
    });
  } catch (err) { return conflict(err); }
}

export async function archiveShelf(db: Db, actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const [shelf] = await tx.select().from(shelves).where(and(eq(shelves.id, id), eq(shelves.orgId, actor.orgId))).for('update');
    if (!shelf) throw new NotFoundError('Shelf');
    if (shelf.archivedAt) throw new ConflictError('SHELF_ARCHIVED', 'This shelf is already archived');
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(categories).where(and(eq(categories.shelfId, id), isNull(categories.archivedAt)));
    if (n > 0) throw new ConflictError('SHELF_NOT_EMPTY', `This shelf still has ${n} active categor${n === 1 ? 'y' : 'ies'}; move or archive them first`, { categoryCount: n });
    await tx.update(shelves).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(shelves.id, id));
    await audit(tx, actor, { action: 'shelf.archived', entityType: 'shelf', entityId: id, previous: { name: shelf.name } });
  });
}

export async function restoreShelf(db: Db, actor: Actor, id: string) {
  try {
    await db.transaction(async (tx) => {
      const [shelf] = await tx.select().from(shelves).where(and(eq(shelves.id, id), eq(shelves.orgId, actor.orgId))).for('update');
      if (!shelf) throw new NotFoundError('Shelf');
      if (!shelf.archivedAt) throw new ConflictError('SHELF_NOT_ARCHIVED', 'This shelf is not archived');
      await tx.update(shelves).set({ archivedAt: null, updatedAt: new Date() }).where(eq(shelves.id, id));
      await audit(tx, actor, { action: 'shelf.restored', entityType: 'shelf', entityId: id });
    });
  } catch (err) { conflict(err); }
}
