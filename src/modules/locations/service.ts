import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { locations } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { env } from '../../env.js';

/** PRD §9: every record is location-aware, but the MVP exposes a single active store per organization (MAX_LOCATIONS_PER_ORG). */
export async function createLocation(db: Db, actor: Actor, input: { name: string; kind?: 'store' | 'site' | 'warehouse' | 'area'; parentId?: string; address?: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`locations:${actor.orgId}`}, 0))`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.orgId, actor.orgId), isNull(locations.archivedAt)));
    if (n >= env.MAX_LOCATIONS_PER_ORG) throw new ConflictError('LOCATION_LIMIT', `Your plan allows ${env.MAX_LOCATIONS_PER_ORG} active location(s)`);
    if (input.parentId) await assertLocation(tx, actor.orgId, input.parentId);
    const [row] = await tx.insert(locations).values({ orgId: actor.orgId, name: input.name.trim(), kind: input.kind ?? 'store', parentId: input.parentId ?? null, address: input.address ?? null }).returning();
    await audit(tx, actor, { action: 'location.created', entityType: 'location', entityId: row.id, next: row });
    return row;
  });
}

export async function assertLocation(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.orgId, orgId))).limit(1);
  if (!row) throw new UnprocessableError('LOCATION_NOT_FOUND', 'Location not found');
  return row;
}

export async function defaultLocation(db: Db, orgId: string) {
  const [row] = await db.select().from(locations).where(and(eq(locations.orgId, orgId), eq(locations.isDefault, true), isNull(locations.archivedAt))).limit(1);
  if (!row) throw new NotFoundError('Default location');
  return row;
}

export const listLocations = (db: Db, orgId: string) =>
  db.select().from(locations).where(eq(locations.orgId, orgId)).orderBy(asc(locations.createdAt));

export async function updateLocation(db: Db, actor: Actor, id: string, patch: { name?: string; address?: string | null }) {
  return db.transaction(async (tx) => {
    const before = await assertLocation(tx, actor.orgId, id).catch(() => { throw new NotFoundError('Location'); });
    const [after] = await tx.update(locations).set({ ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.address !== undefined ? { address: patch.address } : {}) })
      .where(and(eq(locations.id, id), eq(locations.orgId, actor.orgId))).returning();
    await audit(tx, actor, { action: 'location.updated', entityType: 'location', entityId: id, previous: before, next: after });
    return after;
  });
}

export async function archiveLocation(db: Db, actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const loc = await assertLocation(tx, actor.orgId, id).catch(() => { throw new NotFoundError('Location'); });
    if (loc.isDefault) throw new ConflictError('DEFAULT_LOCATION', 'The default location cannot be archived');
    await tx.update(locations).set({ archivedAt: new Date() }).where(eq(locations.id, id));
    await audit(tx, actor, { action: 'location.archived', entityType: 'location', entityId: id });
  });
}
