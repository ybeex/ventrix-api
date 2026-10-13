/**
 * Org-wide announcements (role-based). An admin publishes a message to chosen roles (empty audience = everyone);
 * it is delivered as in-app notifications (and e-mail if requested) by the same idempotent event outbox as every
 * other notification, so publishing is one fast transaction and a crash can never half-deliver it. Callers also get
 * a read endpoint of CURRENTLY ACTIVE announcements for their role (the dashboard banner). Retracting removes the
 * still-unread copies from inboxes.
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { announcements, holders, notifications } from '../../db/schema.js';
import type { Actor, Role } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';

export type AnnouncementRow = typeof announcements.$inferSelect;
const ROLES: Role[] = ['admin', 'supervisor', 'store_staff', 'viewer'];

export async function publish(db: Db, actor: Actor, input: { title: string; body: string; severity?: 'info' | 'warning' | 'critical'; audienceRoles?: Role[]; sendEmail?: boolean; expiresAt?: string }) {
  const audience = [...new Set(input.audienceRoles ?? [])];
  if (audience.some((r) => !ROLES.includes(r))) throw new UnprocessableError('INVALID_AUDIENCE', 'Unknown role in the audience');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt <= new Date()) throw new UnprocessableError('INVALID_EXPIRY', 'The expiry must be in the future');
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(announcements).values({
      orgId: actor.orgId, title: input.title.trim(), body: input.body.trim(), severity: input.severity ?? 'info', audienceRoles: audience,
      sendEmail: input.sendEmail ?? false, publishedBy: actor.id, expiresAt,
    }).returning();
    await audit(tx, actor, { action: 'announcement.published', entityType: 'announcement', entityId: row.id, next: { title: row.title, severity: row.severity, audience: audience.length ? audience : 'everyone', email: row.sendEmail } });
    await emitEvent(tx, actor.orgId, { type: 'announcement.published', announcementId: row.id }, `announcement:${row.id}`);
    return row;
  });
}

export const statusOf = (a: AnnouncementRow, now = new Date()): 'active' | 'expired' | 'retracted' => a.retractedAt ? 'retracted' : a.expiresAt && a.expiresAt <= now ? 'expired' : 'active';

export async function listAnnouncements(db: Db, actor: Actor, opts: { all?: boolean }) {
  const admin = actor.role === 'admin';
  const rows = await db.select({ a: announcements, publisher: holders.name }).from(announcements)
    .leftJoin(holders, and(eq(holders.userId, announcements.publishedBy), eq(holders.orgId, announcements.orgId)))
    .where(and(
      eq(announcements.orgId, actor.orgId),
      admin && opts.all ? undefined : and(isNull(announcements.retractedAt), or(isNull(announcements.expiresAt), sql`${announcements.expiresAt} > now()`)),
      admin && opts.all ? undefined : sql`(jsonb_array_length(${announcements.audienceRoles}) = 0 or ${announcements.audienceRoles} ? ${actor.role})`,
    )).orderBy(desc(announcements.createdAt), desc(announcements.id)).limit(100);

  const stats = admin && opts.all && rows.length
    ? await db.select({ id: notifications.entityId, total: sql<number>`count(*)::int`, read: sql<number>`count(${notifications.readAt})::int` }).from(notifications)
        .where(and(eq(notifications.orgId, actor.orgId), eq(notifications.type, 'announcement'))).groupBy(notifications.entityId)
    : [];
  const byId = new Map(stats.map((s) => [s.id, s]));
  return rows.map(({ a, publisher }) => ({
    id: a.id, title: a.title, body: a.body, severity: a.severity, audienceRoles: a.audienceRoles, sendEmail: a.sendEmail,
    publishedBy: { id: a.publishedBy, name: publisher }, createdAt: a.createdAt.toISOString(), expiresAt: a.expiresAt?.toISOString() ?? null,
    retractedAt: a.retractedAt?.toISOString() ?? null, status: statusOf(a),
    delivered: admin && opts.all ? (byId.get(a.id)?.total ?? 0) : null, read: admin && opts.all ? (byId.get(a.id)?.read ?? 0) : null,
  }));
}

export async function update(db: Db, actor: Actor, id: string, patch: { title?: string; body?: string; severity?: 'info' | 'warning' | 'critical'; expiresAt?: string | null }) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(announcements).where(and(eq(announcements.id, id), eq(announcements.orgId, actor.orgId))).for('update');
    if (!before) throw new NotFoundError('Announcement');
    if (before.retractedAt) throw new ConflictError('ANNOUNCEMENT_RETRACTED', 'A retracted announcement cannot be edited');
    const expiresAt = patch.expiresAt === undefined ? undefined : patch.expiresAt === null ? null : new Date(patch.expiresAt);
    if (expiresAt && expiresAt <= new Date()) throw new UnprocessableError('INVALID_EXPIRY', 'The expiry must be in the future');
    const [after] = await tx.update(announcements).set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}), ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}),
    }).where(eq(announcements.id, id)).returning();
    await audit(tx, actor, { action: 'announcement.updated', entityType: 'announcement', entityId: id, previous: { title: before.title, severity: before.severity, expiresAt: before.expiresAt }, next: { title: after.title, severity: after.severity, expiresAt: after.expiresAt } });
    return after;
  });
}

export async function retract(db: Db, actor: Actor, id: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(announcements).set({ retractedAt: new Date() }).where(and(eq(announcements.id, id), eq(announcements.orgId, actor.orgId), isNull(announcements.retractedAt))).returning();
    if (!row) {
      const [cur] = await tx.select({ id: announcements.id }).from(announcements).where(and(eq(announcements.id, id), eq(announcements.orgId, actor.orgId))).limit(1);
      if (!cur) throw new NotFoundError('Announcement');
      throw new ConflictError('ANNOUNCEMENT_RETRACTED', 'This announcement is already retracted');
    }
    // Copies nobody has opened yet disappear from inboxes; ones already read stay as history.
    const removed = await tx.delete(notifications).where(and(eq(notifications.orgId, actor.orgId), eq(notifications.type, 'announcement'), eq(notifications.entityId, id), isNull(notifications.readAt))).returning({ id: notifications.id });
    await audit(tx, actor, { action: 'announcement.retracted', entityType: 'announcement', entityId: id, next: { unreadCopiesRemoved: removed.length } });
  });
}
