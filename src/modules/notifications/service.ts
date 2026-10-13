/**
 * Notifications (PRD §30): in-app and (where configured) e-mail, for low stock, overdue checkouts,
 * reconciliation discrepancies, failed sync and approvals.
 *
 * Producers (the ledger, approvals, sync, reconciliation) only write a row to `domain_events` inside their own
 * transaction. `processDomainEvents` — run by the worker every few seconds — turns each event into per-user
 * notifications. Consequences: the hot path stays fast; modules never import this one; an event survives any
 * crash between commit and notify; and fan-out is idempotent (notification dedupe key = event id + user), so a
 * retried batch can never notify twice. Each event is handled in its own savepoint, so one poisonous event
 * cannot block the queue behind it; after MAX_ATTEMPTS it is parked with its error instead of retried forever.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Role } from '../../lib/actor.js';
import type { Db } from '../../db/index.js';
import { announcements, domainEvents, holders, items, notificationPreferences, notificationRules, notifications, organizationSettings, shelves, users } from '../../db/schema.js';
import type { Actor } from '../../lib/actor.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { enqueueEmail } from '../mail/outbox.js';
import { outstandingCte } from '../operations/queries.js';
import { notificationEmail } from '../mail/templates.js';

export type NotificationType = (typeof notifications.$inferSelect)['type'];
export const NOTIFICATION_TYPES: NotificationType[] = ['low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending', 'approval_decided', 'announcement', 'cycle_count_due'];
const MAX_ATTEMPTS = 8;

interface Note { type: NotificationType; title: string; body: string; entityType: string; entityId: string; recipients: 'rule' | string[] | { roles: string[] }; forceEmail?: boolean }

/** Default audience for system alerts when the org has not configured routing: the people who run the store. */
export const DEFAULT_ROLES = ['admin', 'supervisor'];
/** Alert types whose audience an admin can route by role (approval_decided goes to the requester; announcements to their own audience). */
export const ROUTABLE_TYPES: NotificationType[] = ['low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending', 'cycle_count_due'];

async function nameOfItem(tx: Db, id: string | null) {
  if (!id) return { name: 'an item', unit: 'pcs' };
  const [r] = await tx.select({ name: items.name, unit: items.unit, number: items.itemNumber }).from(items).where(eq(items.id, id)).limit(1);
  return { name: r ? `${r.name} (${r.number})` : 'an item', unit: r?.unit ?? 'pcs' };
}
async function nameOfPerson(tx: Db, userId: string) {
  const [r] = await tx.select({ n: holders.name }).from(holders).where(eq(holders.userId, userId)).limit(1);
  return r?.n ?? 'Someone';
}

async function describe(tx: Db, ev: { type: string; payload: Record<string, any> }): Promise<Note | null> {
  const p = ev.payload;
  switch (ev.type) {
    case 'stock.low': {
      const it = await nameOfItem(tx, p.itemId);
      return { type: 'low_stock', title: `Low stock: ${it.name}`, body: `${it.name} is down to ${p.balance} ${it.unit} (minimum ${p.minimum}).`, entityType: 'item', entityId: p.itemId, recipients: 'rule' };
    }
    case 'asset.overdue': {
      const it = await nameOfItem(tx, p.itemId);
      const [h] = await tx.select({ n: holders.name }).from(holders).where(eq(holders.id, p.holderId)).limit(1);
      return { type: 'overdue_checkout', title: `Overdue: ${it.name}`, body: `${it.name} was due back ${new Date(p.dueAt).toISOString().slice(0, 16).replace('T', ' ')} UTC and is still with ${h?.n ?? 'its holder'}.`, entityType: 'item', entityId: p.itemId, recipients: 'rule' };
    }
    case 'approval.requested': {
      const it = await nameOfItem(tx, p.itemId);
      return { type: 'approval_pending', title: 'Approval needed', body: `${await nameOfPerson(tx, p.requestedBy)} requested ${String(p.operation).replace('_', ' ')} for ${it.name}.`, entityType: 'approval', entityId: p.approvalId, recipients: 'rule' };
    }
    case 'approval.decided':
      return { type: 'approval_decided', title: `Your request was ${p.decision}`, body: `Your ${String(p.operation).replace('_', ' ')} request was ${p.decision}${p.note ? `: ${p.note}` : '.'}`, entityType: 'approval', entityId: p.approvalId, recipients: [p.requestedBy] };
    case 'reconciliation.discrepancy': {
      const it = await nameOfItem(tx, p.itemId);
      return { type: 'reconciliation_discrepancy', title: `Count discrepancy: ${it.name}`, body: `A count of ${it.name} differed from the system by ${p.variance > 0 ? '+' : ''}${p.variance}.`, entityType: 'reconciliation', entityId: p.reconciliationId, recipients: 'rule' };
    }
    case 'sync.issue':
      return { type: 'sync_failure', title: `Offline action ${p.kind === 'conflict' ? 'conflict' : 'failed'}`, body: `A queued action from device ${p.deviceId} could not be applied (${p.code}). Review it in the sync conflicts list.`, entityType: 'sync_issue', entityId: p.issueId, recipients: 'rule' };
    case 'announcement.published': {
      const [a] = await tx.select().from(announcements).where(eq(announcements.id, p.announcementId)).limit(1);
      if (!a || a.retractedAt) return null;
      return { type: 'announcement', title: a.title, body: a.body, entityType: 'announcement', entityId: a.id, recipients: { roles: a.audienceRoles.length ? a.audienceRoles : ['admin', 'supervisor', 'store_staff', 'viewer'] }, forceEmail: a.sendEmail };
    }
    case 'shelf.count_due': {
      const [sh] = await tx.select({ name: shelves.name }).from(shelves).where(eq(shelves.id, p.shelfId)).limit(1);
      return { type: 'cycle_count_due', title: `Count due: ${sh?.name ?? 'a shelf'}`, body: `${sh?.name ?? 'A shelf'} is due for a count (every ${p.days} days; ${p.lastCountedAt ? `last counted ${String(p.lastCountedAt).slice(0, 10)}` : 'never counted'}).`, entityType: 'shelf', entityId: p.shelfId, recipients: 'rule' };
    }
    default: return null;
  }
}

async function fanOut(tx: Db, ev: typeof domainEvents.$inferSelect): Promise<void> {
  const note = await describe(tx, { type: ev.type, payload: ev.payload as Record<string, any> });
  if (!note) return;
  const requester = (ev.payload as { requestedBy?: string; actorUserId?: string }).requestedBy;
  const rolesFor = async (): Promise<string[]> => {
    if (typeof note.recipients === 'object' && !Array.isArray(note.recipients)) return note.recipients.roles;
    const [rule] = await tx.select({ roles: notificationRules.roles }).from(notificationRules).where(and(eq(notificationRules.orgId, ev.orgId), eq(notificationRules.type, note.type))).limit(1);
    return rule?.roles ?? DEFAULT_ROLES;
  };
  const roles = Array.isArray(note.recipients) ? [] : ((await rolesFor()) as Role[]);
  const people = Array.isArray(note.recipients)
    ? await tx.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.orgId, ev.orgId), eq(users.active, true), inArray(users.id, note.recipients)))
    : roles.length === 0 ? []
    : await tx.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.orgId, ev.orgId), eq(users.active, true), isNotNull(users.passwordHash), inArray(users.role, roles)));
  const [settings] = await tx.select({ t: organizationSettings.notificationEmailTypes }).from(organizationSettings).where(eq(organizationSettings.orgId, ev.orgId)).limit(1);
  const orgEmail = new Set(settings?.t ?? []);
  const prefs = people.length
    ? await tx.select().from(notificationPreferences).where(and(inArray(notificationPreferences.userId, people.map((p) => p.id)), eq(notificationPreferences.type, note.type)))
    : [];
  const prefOf = new Map(prefs.map((p) => [p.userId, p]));

  for (const person of people) {
    if (note.type === 'approval_pending' && person.id === requester) continue; // you don't need to be told about your own request
    const pref = prefOf.get(person.id);
    if (pref?.inApp !== false) {
      await tx.insert(notifications).values({ orgId: ev.orgId, userId: person.id, type: note.type, title: note.title, body: note.body, entityType: note.entityType, entityId: note.entityId, dedupeKey: `${ev.id}:${person.id}` }).onConflictDoNothing();
    }
    if (pref?.email ?? (note.forceEmail || orgEmail.has(note.type))) await enqueueEmail(tx, { orgId: ev.orgId, to: person.email, ...notificationEmail(note.title, note.body) });
  }
}

export async function processDomainEvents(db: Db, batch = 100): Promise<{ processed: number; failed: number }> {
  return db.transaction(async (tx) => {
    const events = await tx.select().from(domainEvents).where(isNull(domainEvents.processedAt)).orderBy(domainEvents.createdAt).limit(batch).for('update', { skipLocked: true });
    let processed = 0; let failed = 0;
    for (const ev of events) {
      try {
        await tx.transaction(async (sp) => { await fanOut(sp, ev); await sp.update(domainEvents).set({ processedAt: new Date() }).where(eq(domainEvents.id, ev.id)); }); // savepoint per event
        processed++;
      } catch (err) {
        failed++;
        const attempts = ev.attempts + 1;
        await tx.update(domainEvents).set({ attempts, lastError: String((err as Error).message).slice(0, 500), ...(attempts >= MAX_ATTEMPTS ? { processedAt: new Date() } : {}) }).where(eq(domainEvents.id, ev.id));
      }
    }
    return { processed, failed };
  });
}

/**
 * Overdue scan: one set-based INSERT…SELECT over the SAME outstanding definition the Overdue list uses (assets and consumable lines).
 * The dedupe key (item [+ holder for consumables] + due instant) makes each overdue episode notify exactly once.
 */
export async function scanOverdue(db: Db): Promise<number> {
  const r = await db.execute(sql`
    with ${outstandingCte()}
    insert into domain_events (org_id, type, payload, dedupe_key)
    select i.org_id, 'asset.overdue', jsonb_build_object('itemId', o.item_id, 'holderId', o.holder_id, 'dueAt', o.due_at),
           'overdue:' || o.item_id || ':' || (case when i.type = 'asset' then '' else o.holder_id::text || ':' end) || extract(epoch from o.due_at)::bigint
    from out o join items i on i.id = o.item_id
    where o.due_at is not null and o.due_at < now()
    on conflict do nothing
    returning id`);
  return (Array.isArray(r) ? r : (r as unknown as { rows: unknown[] }).rows).length;
}

// ── User-facing API ─────────────────────────────────────────────────

export async function listNotifications(db: Db, userId: string, q: { unreadOnly?: boolean; cursor?: string; limit: number }) {
  const rows = await db.select().from(notifications).where(and(
    eq(notifications.userId, userId), q.unreadOnly ? isNull(notifications.readAt) : undefined, q.cursor ? keysetWhere(notifications.createdAt, notifications.id, q.cursor) : undefined,
  )).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(q.limit + 1);
  return toPage(rows, q.limit);
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r.n;
}

export async function markRead(db: Db, userId: string, id: string): Promise<void> {
  const r = await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, now())` }).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).returning({ id: notifications.id });
  if (r.length === 0) throw new NotFoundError('Notification');
}

export async function markAllRead(db: Db, userId: string): Promise<number> {
  return (await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt))).returning({ id: notifications.id })).length;
}

export async function getPreferences(db: Db, userId: string, orgId: string) {
  const [settings] = await db.select({ t: organizationSettings.notificationEmailTypes }).from(organizationSettings).where(eq(organizationSettings.orgId, orgId)).limit(1);
  const orgEmail = new Set(settings?.t ?? []);
  const prefs = new Map((await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId))).map((p) => [p.type, p]));
  return NOTIFICATION_TYPES.map((type) => ({ type, inApp: prefs.get(type)?.inApp ?? true, email: prefs.get(type)?.email ?? orgEmail.has(type), emailIsOrgDefault: prefs.get(type)?.email == null }));
}

export async function setPreference(db: Db, actor: Actor, type: NotificationType, v: { inApp?: boolean; email?: boolean | null }) {
  const userId = actor.id;
  await db.transaction(async (tx) => {
  await tx.insert(notificationPreferences).values({ userId, type, inApp: v.inApp ?? true, email: v.email ?? null })
    .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.type], set: { ...(v.inApp !== undefined ? { inApp: v.inApp } : {}), ...(v.email !== undefined ? { email: v.email } : {}) } });
  await audit(tx, actor, { action: 'notification.preferences_changed', entityType: 'user', entityId: userId, next: { type, ...v } });
  });
}

/** Shelves whose recurring count is overdue: one reminder per cycle (dedupe key = the due instant), only for shelves that hold items. */
export async function scanCycleCounts(db: Db): Promise<number> {
  const r = await db.execute(sql`
    insert into domain_events (org_id, type, payload, dedupe_key)
    select s.org_id, 'shelf.count_due', jsonb_build_object('shelfId', s.id, 'days', s.cycle_count_days, 'lastCountedAt', lc.last),
           'cc:' || s.id || ':' || extract(epoch from (coalesce(lc.last, s.created_at) + make_interval(days => s.cycle_count_days)))::bigint
    from shelves s
    left join lateral (select max(r.closed_at) as last from reconciliations r where r.org_id = s.org_id and r.scope = 'shelf' and r.scope_id = s.id and r.status = 'closed') lc on true
    where s.archived_at is null and s.cycle_count_days is not null
      and coalesce(lc.last, s.created_at) + make_interval(days => s.cycle_count_days) < now()
      and exists (select 1 from categories c join items i on i.category_id = c.id where c.shelf_id = s.id and i.archived_at is null)
    on conflict do nothing
    returning id`);
  return (Array.isArray(r) ? r : (r as unknown as { rows: unknown[] }).rows).length;
}

export async function getRules(db: Db, orgId: string) {
  const rows = await db.select().from(notificationRules).where(eq(notificationRules.orgId, orgId));
  const by = new Map(rows.map((r) => [r.type, r.roles]));
  return ROUTABLE_TYPES.map((type) => ({ type, roles: by.get(type) ?? DEFAULT_ROLES, isDefault: !by.has(type) }));
}

export async function setRule(db: Db, actor: Actor, type: NotificationType, roles: string[]) {
  if (!ROUTABLE_TYPES.includes(type)) throw new UnprocessableError('NOT_CONFIGURABLE', `"${type}" notifications are not routed by role (approval decisions go to the requester; announcements to their own audience)`);
  const unique = [...new Set(roles)];
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ roles: notificationRules.roles }).from(notificationRules).where(and(eq(notificationRules.orgId, actor.orgId), eq(notificationRules.type, type))).limit(1);
    await tx.insert(notificationRules).values({ orgId: actor.orgId, type, roles: unique, updatedBy: actor.id })
      .onConflictDoUpdate({ target: [notificationRules.orgId, notificationRules.type], set: { roles: unique, updatedBy: actor.id, updatedAt: new Date() } });
    await audit(tx, actor, { action: 'notification.rules_changed', entityType: 'organization', entityId: actor.orgId, previous: { type, roles: before?.roles ?? DEFAULT_ROLES }, next: { type, roles: unique } });
  });
}
