import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { announcements, auditEvents, categories, holders, items, jobs, locations, shelves, transactions } from '../../db/schema.js';
import { AUDIT_ACTIONS, humanizeAction } from '../../lib/audit-catalog.js';
import { summarizeAudit, summarizeTx } from '../../lib/describe.js';
import { decodeSeqCursor, toSeqPage } from '../../lib/pagination.js';

export interface ActivityFilters { action?: string; category?: string; entityType?: string; entityId?: string; actorId?: string; from?: Date; to?: Date; cursor?: string; limit: number }

type Entity = { type: string; id: string };

/** One small lookup per entity type present on the page (never a join explosion) → "Angle grinder 12", "Main shelf", "Ben"… */
async function entityNames(db: Db, orgId: string, ents: Entity[]): Promise<Map<string, string>> {
  const ids = (t: string) => [...new Set(ents.filter((e) => e.type === t).map((e) => e.id))].filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  const out = new Map<string, string>();
  const put = (type: string, rows: Array<{ id: string; name: string | null }>) => rows.forEach((r) => r.name && out.set(`${type}:${r.id}`, r.name));
  const [it, sh, ca, ho, us, jo, lo, an] = [ids('item'), ids('shelf'), ids('category'), ids('holder'), ids('user'), ids('job'), ids('location'), ids('announcement')];
  await Promise.all([
    it.length ? db.select({ id: items.id, name: items.name }).from(items).where(and(eq(items.orgId, orgId), inArray(items.id, it))).then((r) => put('item', r)) : null,
    sh.length ? db.select({ id: shelves.id, name: shelves.name }).from(shelves).where(and(eq(shelves.orgId, orgId), inArray(shelves.id, sh))).then((r) => put('shelf', r)) : null,
    ca.length ? db.select({ id: categories.id, name: categories.name }).from(categories).where(and(eq(categories.orgId, orgId), inArray(categories.id, ca))).then((r) => put('category', r)) : null,
    ho.length ? db.select({ id: holders.id, name: holders.name }).from(holders).where(and(eq(holders.orgId, orgId), inArray(holders.id, ho))).then((r) => put('holder', r)) : null,
    us.length ? db.select({ id: holders.userId, name: holders.name }).from(holders).where(and(eq(holders.orgId, orgId), inArray(holders.userId, us))).then((r) => put('user', r.map((x) => ({ id: x.id!, name: x.name })))) : null,
    jo.length ? db.select({ id: jobs.id, name: jobs.name }).from(jobs).where(and(eq(jobs.orgId, orgId), inArray(jobs.id, jo))).then((r) => put('job', r)) : null,
    lo.length ? db.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.orgId, orgId), inArray(locations.id, lo))).then((r) => put('location', r)) : null,
    an.length ? db.select({ id: announcements.id, name: announcements.title }).from(announcements).where(and(eq(announcements.orgId, orgId), inArray(announcements.id, an))).then((r) => put('announcement', r)) : null,
  ]);
  return out;
}

export async function listActivity(db: Db, orgId: string, f: ActivityFilters) {
  const categoryActions = f.category ? Object.entries(AUDIT_ACTIONS).filter(([, v]) => v.category === f.category).map(([k]) => k) : null;
  const rows = await db.select({ e: auditEvents, actorName: holders.name }).from(auditEvents)
    .leftJoin(holders, and(eq(holders.userId, auditEvents.actorUserId), eq(holders.orgId, auditEvents.orgId)))
    .where(and(
      eq(auditEvents.orgId, orgId),
      f.action ? (f.action.endsWith('.*') ? sql`${auditEvents.action} like ${f.action.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`) + '%'}` : eq(auditEvents.action, f.action)) : undefined,
      categoryActions ? inArray(auditEvents.action, categoryActions.length ? categoryActions : ['__none__']) : undefined,
      f.entityType ? eq(auditEvents.entityType, f.entityType) : undefined, f.entityId ? eq(auditEvents.entityId, f.entityId) : undefined,
      f.actorId ? eq(auditEvents.actorUserId, f.actorId) : undefined,
      f.from ? gte(auditEvents.createdAt, f.from) : undefined, f.to ? lte(auditEvents.createdAt, f.to) : undefined,
      f.cursor ? sql`${auditEvents.seq} < ${decodeSeqCursor(f.cursor)}` : undefined,
    )).orderBy(desc(auditEvents.seq)).limit(f.limit + 1);
  const page = toSeqPage(rows.map((r) => ({ ...r, seq: r.e.seq })), f.limit);

  const names = await entityNames(db, orgId, page.items.flatMap(({ e }) => [{ type: e.entityType, id: e.entityId }]));
  // Ledger-backed events read from the ledger row itself, so the sentence always matches what was recorded.
  const txIds = page.items.map(({ e }) => e.transactionId).filter((x): x is string => !!x);
  const txRows = txIds.length
    ? await db.select({ t: transactions, holderName: holders.name }).from(transactions).leftJoin(holders, eq(holders.id, transactions.holderId)).where(and(eq(transactions.orgId, orgId), inArray(transactions.id, txIds)))
    : [];
  const txById = new Map(txRows.map((r) => [r.t.id, r]));

  return {
    items: page.items.map(({ e, actorName }) => {
      const entityName = names.get(`${e.entityType}:${e.entityId}`) ?? (e.entityType === 'report' ? e.entityId : null); // a report's id IS its name ("inventory")
      const tx = e.transactionId ? txById.get(e.transactionId) : undefined;
      const summary = tx && e.action.startsWith('transaction.')
        ? summarizeTx(tx.t, { actor: actorName, item: entityName, holder: tx.holderName })
        : summarizeAudit({ action: e.action, previous: e.previous, next: e.next, reason: e.reason }, { actor: actorName, entity: entityName });
      return {
        id: e.id, sequence: e.seq, action: e.action, label: humanizeAction(e.action), category: AUDIT_ACTIONS[e.action]?.category ?? 'Other', summary,
        entity: { type: e.entityType, id: e.entityId, name: entityName },
        actor: e.actorUserId ? { id: e.actorUserId, name: actorName } : null,
        previous: e.previous, next: e.next, reason: e.reason, transactionId: e.transactionId, requestId: e.requestId, ip: e.ip, createdAt: e.createdAt.toISOString(),
      };
    }),
    nextCursor: page.nextCursor,
  };
}

export const actionCatalog = () => Object.entries(AUDIT_ACTIONS).map(([action, v]) => ({ action, label: v.label, category: v.category })).sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
