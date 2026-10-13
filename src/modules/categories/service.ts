/**
 * Categories live on exactly one shelf and hold items. A category is created on an EXISTING shelf (shelves and categories are
 * created separately) and can later be MOVED to another shelf; items under it follow (their location is derived from the shelf).
 * Archiving a category that still holds active items is refused — move or archive the items first — so nothing is ever orphaned.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, items, shelves } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { toDate } from '../../lib/sql.js';
import { assertUsableShelf } from '../shelves/service.js';

export type CategoryRow = typeof categories.$inferSelect;
export type CategoryWithShelf = CategoryRow & { shelfLocationId: string; shelfName: string };
type Input = { name: string; shelfId: string; codePrefix?: string | null; defaultMinQuantity?: number | null; defaultExpectedReturnHours?: number | null };
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

/** A category usable as the parent of an item: in this org and not archived. Also yields its shelf's location (an item's derived location). */
export async function assertUsableCategory(db: Db, orgId: string, id: string): Promise<CategoryWithShelf> {
  const [row] = await db.select({ c: categories, shelfLocationId: shelves.locationId, shelfName: shelves.name, shelfArchived: shelves.archivedAt })
    .from(categories).innerJoin(shelves, eq(shelves.id, categories.shelfId)).where(and(eq(categories.id, id), eq(categories.orgId, orgId))).limit(1);
  if (!row) throw new UnprocessableError('CATEGORY_NOT_FOUND', 'Category not found');
  if (row.c.archivedAt || row.shelfArchived) throw new UnprocessableError('CATEGORY_ARCHIVED', 'This category (or its shelf) is archived');
  return { ...row.c, shelfLocationId: row.shelfLocationId, shelfName: row.shelfName };
}

const taken = (err: unknown): never => {
  if (isUniqueViolation(err, 'categories_org_name_unique')) throw new ConflictError('CATEGORY_NAME_TAKEN', 'A category with this name already exists');
  throw err;
};

export async function createCategory(db: Db, actor: Actor, input: Input) {
  try {
    return await db.transaction(async (tx) => {
      const shelf = await assertUsableShelf(tx, actor.orgId, input.shelfId);
      const [row] = await tx.insert(categories).values({
        orgId: actor.orgId, shelfId: shelf.id, name: input.name.trim(), codePrefix: input.codePrefix ?? null,
        defaultMinQuantity: input.defaultMinQuantity ?? null, defaultExpectedReturnHours: input.defaultExpectedReturnHours ?? null,
      }).returning();
      await audit(tx, actor, { action: 'category.created', entityType: 'category', entityId: row.id, next: { name: row.name, shelfId: row.shelfId, codePrefix: row.codePrefix } });
      return row;
    });
  } catch (err) { return taken(err); }
}

export interface CategoryListRow extends CategoryRow { shelfName: string; itemCount: number }

export async function listCategories(db: Db, orgId: string, q: { includeArchived?: boolean; shelfId?: string } = {}): Promise<CategoryListRow[]> {
  const rows = rowsOf<Record<string, any>>(await db.execute(sql`
    select c.*, s.name as shelf_name, (select count(*)::int from items i where i.category_id = c.id and i.archived_at is null) as item_count
    from categories c join shelves s on s.id = c.shelf_id
    where c.org_id = ${orgId} ${q.includeArchived ? sql`` : sql`and c.archived_at is null`} ${q.shelfId ? sql`and c.shelf_id = ${q.shelfId}` : sql``}
    order by s.position, s.name, c.name`));
  return rows.map((r) => ({
    id: r.id, orgId: r.org_id, shelfId: r.shelf_id, name: r.name, codePrefix: r.code_prefix, defaultMinQuantity: r.default_min_quantity,
    defaultExpectedReturnHours: r.default_expected_return_hours, archivedAt: toDate(r.archived_at), createdAt: toDate(r.created_at)!, shelfName: r.shelf_name, itemCount: r.item_count,
  }));
}

export async function getCategory(db: Db, orgId: string, id: string): Promise<CategoryListRow> {
  const found = (await listCategories(db, orgId, { includeArchived: true })).find((c) => c.id === id);
  if (!found) throw new NotFoundError('Category');
  return found;
}

/** Editable descriptive fields. The shelf is changed only through `moveCategory`, which also re-derives item locations. */
export async function updateCategory(db: Db, actor: Actor, id: string, patch: Partial<Omit<Input, 'shelfId'>>) {
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(categories).where(and(eq(categories.id, id), eq(categories.orgId, actor.orgId))).limit(1);
      if (!before) throw new NotFoundError('Category');
      const set: Partial<typeof categories.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name.trim();
      if (patch.codePrefix !== undefined) set.codePrefix = patch.codePrefix;
      if (patch.defaultMinQuantity !== undefined) set.defaultMinQuantity = patch.defaultMinQuantity;
      if (patch.defaultExpectedReturnHours !== undefined) set.defaultExpectedReturnHours = patch.defaultExpectedReturnHours;
      const [after] = await tx.update(categories).set(set).where(and(eq(categories.id, id), eq(categories.orgId, actor.orgId))).returning();
      await audit(tx, actor, { action: 'category.updated', entityType: 'category', entityId: id, previous: { name: before.name, codePrefix: before.codePrefix, defaultMinQuantity: before.defaultMinQuantity, defaultExpectedReturnHours: before.defaultExpectedReturnHours }, next: { name: after.name, codePrefix: after.codePrefix, defaultMinQuantity: after.defaultMinQuantity, defaultExpectedReturnHours: after.defaultExpectedReturnHours } });
      return after;
    });
  } catch (err) { return taken(err); }
}

export async function moveCategory(db: Db, actor: Actor, id: string, shelfId: string) {
  return db.transaction(async (tx) => {
    const [cat] = await tx.select().from(categories).where(and(eq(categories.id, id), eq(categories.orgId, actor.orgId))).for('update');
    if (!cat) throw new NotFoundError('Category');
    if (cat.archivedAt) throw new ConflictError('CATEGORY_ARCHIVED', 'Restore this category before moving it');
    const shelf = await assertUsableShelf(tx, actor.orgId, shelfId);
    if (cat.shelfId === shelf.id) return { category: cat, itemsRelocated: 0 };
    const [after] = await tx.update(categories).set({ shelfId: shelf.id }).where(eq(categories.id, id)).returning();
    // Items follow their shelf: re-derive location in the same transaction (touching updated_at so offline devices pick the change up).
    const moved = await tx.update(items).set({ locationId: shelf.locationId, updatedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(items.orgId, actor.orgId), eq(items.categoryId, id), sql`${items.locationId} <> ${shelf.locationId}`)).returning({ id: items.id });
    await tx.update(items).set({ updatedAt: new Date() }).where(and(eq(items.orgId, actor.orgId), eq(items.categoryId, id)));
    await audit(tx, actor, { action: 'category.moved', entityType: 'category', entityId: id, previous: { shelfId: cat.shelfId }, next: { shelfId: shelf.id, itemsRelocated: moved.length } });
    return { category: after, itemsRelocated: moved.length };
  });
}

export async function archiveCategory(db: Db, actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const [cat] = await tx.select().from(categories).where(and(eq(categories.id, id), eq(categories.orgId, actor.orgId))).for('update');
    if (!cat) throw new NotFoundError('Category');
    if (cat.archivedAt) throw new ConflictError('CATEGORY_ARCHIVED', 'This category is already archived');
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(items).where(and(eq(items.categoryId, id), isNull(items.archivedAt)));
    if (n > 0) throw new ConflictError('CATEGORY_NOT_EMPTY', `This category still holds ${n} active item${n === 1 ? '' : 's'}; move or archive them first`, { itemCount: n });
    await tx.update(categories).set({ archivedAt: new Date() }).where(eq(categories.id, id));
    await audit(tx, actor, { action: 'category.archived', entityType: 'category', entityId: id, previous: { name: cat.name } });
  });
}

export async function restoreCategory(db: Db, actor: Actor, id: string) {
  try {
    await db.transaction(async (tx) => {
      const [cat] = await tx.select().from(categories).where(and(eq(categories.id, id), eq(categories.orgId, actor.orgId))).for('update');
      if (!cat) throw new NotFoundError('Category');
      if (!cat.archivedAt) throw new ConflictError('CATEGORY_NOT_ARCHIVED', 'This category is not archived');
      await assertUsableShelf(tx, actor.orgId, cat.shelfId).catch(() => { throw new ConflictError('SHELF_ARCHIVED', 'Restore the shelf first, or move this category to an active shelf'); });
      await tx.update(categories).set({ archivedAt: null }).where(eq(categories.id, id));
      await audit(tx, actor, { action: 'category.restored', entityType: 'category', entityId: id });
    });
  } catch (err) { taken(err); }
}
