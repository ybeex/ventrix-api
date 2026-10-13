import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { items, transactions } from '../../db/schema.js';
import { nextCounterValue } from '../../lib/counters.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { assertUsableCategory } from '../categories/service.js';
import { assertFile } from '../files/service.js';
import { fingerprintOf } from '../../lib/canonical.js';
import { recordTx } from '../transactions/ledger.js';
import { assertSameRequest, countReplay, findByKey, lockKey } from '../transactions/idempotency.js';

export type ItemRow = typeof items.$inferSelect;

export interface CreateItemInput {
  type: 'asset' | 'consumable'; name: string; description?: string; sku?: string; code?: string; categoryId: string;
  unit?: string; photoFileId?: string; expectedReturnHours?: number;
  openingQuantity?: number; minQuantity?: number; reorderQuantity?: number;
}

const uniqueToConflict = (err: unknown): never => {
  if (isUniqueViolation(err, 'items_org_sku_unique')) throw new ConflictError('SKU_TAKEN', 'An active item with this SKU already exists');
  if (isUniqueViolation(err, 'items_org_code_unique')) throw new ConflictError('CODE_TAKEN', 'An active item with this code already exists');
  throw err;
};

/**
 * A scannable code must resolve to exactly one item, so it may never equal ANOTHER item's human Item ID
 * (lookup tries code first, then Item ID — a clash would make the second item unreachable by its own ID),
 * nor another active item's code (the unique index also guards this).
 */
async function assertCodeFree(tx: Db, orgId: string, code: string, selfId?: string): Promise<void> {
  const [clash] = await tx.select({ id: items.id }).from(items).where(and(
    eq(items.orgId, orgId), selfId ? sql`${items.id} <> ${selfId}` : undefined,
    sql`(upper(${items.itemNumber}) = upper(${code}) or (${items.code} = ${code} and ${items.archivedAt} is null))`,
  )).limit(1);
  if (clash) throw new ConflictError('CODE_TAKEN', 'This code is already used by another item (as its code or its Item ID)');
}

/** Allocates the next human Item ID, skipping any number a custom code has already claimed (so defaults never collide). */
export async function nextItemNumber(tx: Db, orgId: string, prefix: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const n = await nextCounterValue(tx, orgId, prefix);
    const candidate = `${prefix}-${String(n).padStart(4, '0')}`;
    const [taken] = await tx.select({ id: items.id }).from(items).where(and(eq(items.orgId, orgId), eq(items.code, candidate), isNull(items.archivedAt))).limit(1);
    if (!taken) return candidate;
  }
  throw new ConflictError('ITEM_NUMBER_EXHAUSTED', 'Could not allocate an Item ID; please retry');
}

export async function createItem(db: Db, actor: Actor, input: CreateItemInput, key: string): Promise<{ item: ItemRow; replayed: boolean }> {
  const isAsset = input.type === 'asset';
  if (isAsset && (input.openingQuantity !== undefined || input.minQuantity !== undefined || input.reorderQuantity !== undefined)) {
    throw new UnprocessableError('NOT_APPLICABLE', 'Quantities and thresholds apply to consumables only; each tracked asset is a single unit');
  }
  if (!isAsset && input.expectedReturnHours !== undefined) throw new UnprocessableError('NOT_APPLICABLE', 'Expected return period applies to tracked assets only');

  const fingerprint = fingerprintOf('item.create', input);
  try {
    return await db.transaction(async (tx) => {
      await lockKey(tx, actor.orgId, actor.id, key);
      const prior = await findByKey(tx, actor.orgId, actor.id, key);
      if (prior) {
        assertSameRequest(prior.requestFingerprint, fingerprint);
        countReplay('create');
        const [existing] = await tx.select().from(items).where(eq(items.id, prior.itemId)).limit(1);
        return { item: existing, replayed: true };
      }
      // Every item lives in exactly one category; the category's shelf decides the item's location (derived, never client-supplied).
      const category = await assertUsableCategory(tx, actor.orgId, input.categoryId);
      const location = { id: category.shelfLocationId };
      if (input.photoFileId) await assertFile(tx, actor.orgId, input.photoFileId, 'item_photo');

      if (input.code) await assertCodeFree(tx, actor.orgId, input.code.trim());
      const itemNumber = await nextItemNumber(tx, actor.orgId, category.codePrefix ?? (isAsset ? 'AST' : 'STK'));
      const opening = isAsset ? null : (input.openingQuantity ?? 0);

      const [item] = await tx.insert(items).values({
        orgId: actor.orgId, itemNumber, type: input.type, sku: input.sku?.trim() || null, code: input.code?.trim() || itemNumber,
        name: input.name.trim(), description: input.description ?? null, categoryId: category.id, locationId: location.id,
        photoFileId: input.photoFileId ?? null, unit: input.unit?.trim() || 'pcs',
        assetState: isAsset ? 'available' : null, condition: isAsset ? 'good' : null, expectedReturnHours: input.expectedReturnHours ?? null,
        quantityAvailable: opening, minQuantity: input.minQuantity ?? null, reorderQuantity: input.reorderQuantity ?? null,
        createdBy: actor.id, updatedBy: actor.id,
      }).returning();

      // PRD §12: Available = Opening Balance + …. The opening balance is itself a ledger fact, so the balance is provable from history.
      await recordTx(tx, actor, {
        type: 'create', itemId: item.id, locationId: location.id,
        quantity: opening, stockDelta: opening ?? 0, balanceBefore: isAsset ? null : 0, balanceAfter: opening,
        stateBefore: null, stateAfter: isAsset ? 'available' : null, condition: isAsset ? 'good' : null,
        note: opening ? 'Opening balance' : null, idempotencyKey: key, requestFingerprint: fingerprint,
      });
      return { item, replayed: false };
    });
  } catch (err) { return uniqueToConflict(err); }
}

export interface UpdateItemInput {
  name?: string; description?: string | null; sku?: string | null; code?: string;
  unit?: string; photoFileId?: string | null; expectedReturnHours?: number | null; minQuantity?: number | null; reorderQuantity?: number | null;
}

/** Editable descriptive fields only. Type, quantity, state, holder and condition are NOT here — they change only through ledger operations. */
export async function updateItem(db: Db, actor: Actor, id: string, patch: UpdateItemInput): Promise<ItemRow> {
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(items).where(and(eq(items.id, id), eq(items.orgId, actor.orgId))).limit(1);
      if (!before) throw new NotFoundError('Item');
      if (before.archivedAt) throw new ConflictError('ITEM_ARCHIVED', 'Archived items cannot be edited; restore the item first');
      const asset = before.type === 'asset';
      if (asset && (patch.minQuantity !== undefined || patch.reorderQuantity !== undefined)) throw new UnprocessableError('NOT_APPLICABLE', 'Thresholds apply to consumables only');
      if (!asset && patch.expectedReturnHours !== undefined) throw new UnprocessableError('NOT_APPLICABLE', 'Expected return period applies to tracked assets only');
      if (patch.code && patch.code.trim() !== before.code) await assertCodeFree(tx, actor.orgId, patch.code.trim(), id);
      if (patch.photoFileId) await assertFile(tx, actor.orgId, patch.photoFileId, 'item_photo');

      const set: Partial<typeof items.$inferInsert> = {};
      const prev: Record<string, unknown> = {};
      const next: Record<string, unknown> = {};
      const apply = <K extends keyof UpdateItemInput & keyof typeof items.$inferInsert>(k: K, val: (typeof items.$inferInsert)[K] | undefined) => {
        if (val === undefined || val === (before as Record<string, unknown>)[k]) return;
        (set as Record<string, unknown>)[k] = val; prev[k] = (before as Record<string, unknown>)[k]; next[k] = val;
      };
      apply('name', patch.name?.trim()); apply('description', patch.description); apply('sku', patch.sku === undefined ? undefined : patch.sku?.trim() || null);
      apply('code', patch.code?.trim()); apply('unit', patch.unit?.trim());
      apply('photoFileId', patch.photoFileId); apply('expectedReturnHours', patch.expectedReturnHours);
      apply('minQuantity', patch.minQuantity); apply('reorderQuantity', patch.reorderQuantity);

      if (Object.keys(set).length === 0) return before;
      const [after] = await tx.update(items).set({ ...set, updatedBy: actor.id, updatedAt: new Date() }).where(eq(items.id, id)).returning();
      await audit(tx, actor, { action: 'item.updated', entityType: 'item', entityId: id, previous: prev, next });
      return after;
    });
  } catch (err) { return uniqueToConflict(err); }
}

export async function archiveItem(db: Db, actor: Actor, id: string, note?: string): Promise<ItemRow> {
  return db.transaction(async (tx) => {
    // The UPDATE takes the row lock first; a concurrent checkout either committed before (visible below) or fails its archived_at guard.
    const [item] = await tx.update(items).set({ archivedAt: new Date(), updatedBy: actor.id, updatedAt: new Date() })
      .where(and(eq(items.id, id), eq(items.orgId, actor.orgId), isNull(items.archivedAt), sql`${items.assetState} is distinct from 'checked_out'`)).returning();
    if (!item) {
      const [cur] = await tx.select().from(items).where(and(eq(items.id, id), eq(items.orgId, actor.orgId))).limit(1);
      if (!cur) throw new NotFoundError('Item');
      if (cur.archivedAt) throw new ConflictError('ITEM_ARCHIVED', 'This item is already archived');
      throw new ConflictError('ITEM_IN_USE', 'This asset is checked out; record its return before archiving');
    }
    if (item.type === 'consumable') {
      const out = await tx.select({ n: sql<number>`sum(${transactions.custodyDelta})::int` }).from(transactions)
        .where(and(eq(transactions.orgId, actor.orgId), eq(transactions.itemId, id))).groupBy(transactions.holderId)
        .having(sql`sum(${transactions.custodyDelta}) > 0`).limit(1);
      if (out.length) throw new ConflictError('ITEM_HAS_OUTSTANDING', 'Some of this item is still checked out; record the returns before archiving');
    }
    await recordTx(tx, actor, {
      type: 'archive', itemId: id, locationId: item.locationId, note: note ?? null,
      balanceBefore: item.quantityAvailable, balanceAfter: item.quantityAvailable, stateBefore: item.assetState, stateAfter: item.assetState,
    });
    return item;
  });
}

export async function restoreItem(db: Db, actor: Actor, id: string, note?: string): Promise<ItemRow> {
  try {
    return await db.transaction(async (tx) => {
      const [cur] = await tx.select({ categoryId: items.categoryId }).from(items).where(and(eq(items.id, id), eq(items.orgId, actor.orgId))).limit(1);
      if (!cur) throw new NotFoundError('Item');
      await assertUsableCategory(tx, actor.orgId, cur.categoryId).catch(() => { throw new ConflictError('CATEGORY_ARCHIVED', "This item's category is archived; restore the category (or move the item to an active one) first"); });
      const [item] = await tx.update(items).set({ archivedAt: null, updatedBy: actor.id, updatedAt: new Date() })
        .where(and(eq(items.id, id), eq(items.orgId, actor.orgId), sql`${items.archivedAt} is not null`)).returning();
      if (!item) {
        const [cur] = await tx.select({ id: items.id }).from(items).where(and(eq(items.id, id), eq(items.orgId, actor.orgId))).limit(1);
        if (!cur) throw new NotFoundError('Item');
        throw new ConflictError('ITEM_NOT_ARCHIVED', 'This item is not archived');
      }
      await recordTx(tx, actor, {
        type: 'restore', itemId: id, locationId: item.locationId, note: note ?? null,
        balanceBefore: item.quantityAvailable, balanceAfter: item.quantityAvailable, stateBefore: item.assetState, stateAfter: item.assetState,
      });
      return item;
    });
  } catch (err) { return uniqueToConflict(err); }
}

/** Moves one item to another category (and, through the category's shelf, to that shelf's location). History is untouched; the move is audited. */
async function moveOne(tx: Db, actor: Actor, id: string, categoryId: string): Promise<boolean> {
  const [item] = await tx.select().from(items).where(and(eq(items.id, id), eq(items.orgId, actor.orgId))).for('update');
  if (!item) throw new NotFoundError('Item');
  if (item.archivedAt) throw new ConflictError('ITEM_ARCHIVED', 'Restore this item before moving it');
  const target = await assertUsableCategory(tx, actor.orgId, categoryId);
  if (item.categoryId === target.id) return false;
  await tx.update(items).set({ categoryId: target.id, locationId: target.shelfLocationId, updatedBy: actor.id, updatedAt: new Date() }).where(eq(items.id, id));
  await audit(tx, actor, { action: 'item.moved', entityType: 'item', entityId: id, previous: { categoryId: item.categoryId, locationId: item.locationId }, next: { categoryId: target.id, shelfId: target.shelfId, locationId: target.shelfLocationId } });
  return true;
}

export const moveItem = (db: Db, actor: Actor, id: string, categoryId: string) => db.transaction((tx) => moveOne(tx, actor, id, categoryId));

/** Bulk move, all-or-nothing, in a canonical lock order (two concurrent bulk moves cannot deadlock). */
export async function moveItems(db: Db, actor: Actor, ids: string[], categoryId: string): Promise<{ moved: number; unchanged: number }> {
  const unique = [...new Set(ids)].sort();
  return db.transaction(async (tx) => {
    let moved = 0;
    for (const id of unique) if (await moveOne(tx, actor, id, categoryId)) moved++;
    return { moved, unchanged: unique.length - moved };
  });
}
