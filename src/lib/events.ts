/**
 * Transactional outbox for domain events. Modules that *cause* something worth telling
 * people about (stock crossing its minimum, an approval being requested, a sync conflict)
 * write a row here inside their own DB transaction — they know nothing about notifications,
 * e-mail or users. A worker (modules/notifications/worker) fans events out later.
 * Result: the ledger hot path stays fast, modules stay decoupled, and an event can never be
 * lost to a crash between "commit" and "notify".
 */
import type { Db } from '../db/index.js';
import { domainEvents } from '../db/schema.js';

export type DomainEvent =
  | { type: 'stock.low'; itemId: string; balance: number; minimum: number }
  | { type: 'asset.overdue'; itemId: string; holderId: string; dueAt: string }
  | { type: 'approval.requested'; approvalId: string; operation: string; requestedBy: string; itemId: string | null }
  | { type: 'approval.decided'; approvalId: string; operation: string; requestedBy: string; decision: 'approved' | 'rejected'; reviewedBy: string; note: string | null }
  | { type: 'reconciliation.discrepancy'; reconciliationId: string; countId: string; itemId: string; variance: number; countedBy: string }
  | { type: 'announcement.published'; announcementId: string }
  | { type: 'shelf.count_due'; shelfId: string; days: number; lastCountedAt: string | null }
  | { type: 'sync.issue'; issueId: string; kind: 'conflict' | 'rejected'; code: string; itemId: string | null; actorUserId: string; deviceId: string };

export async function emitEvent(tx: Db, orgId: string, event: DomainEvent, dedupeKey?: string): Promise<void> {
  const { type, ...payload } = event;
  await tx.insert(domainEvents).values({ orgId, type, payload, dedupeKey: dedupeKey ?? null }).onConflictDoNothing();
}
