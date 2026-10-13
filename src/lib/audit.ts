/**
 * PRD §24: every material event records what happened, who did it, what it affected, when,
 * previous and new state, the reason and the associated transaction. Written in the SAME
 * database transaction as the change itself — an audit row can never exist without its
 * change, nor a change without its audit row. audit_events is append-only (DB trigger).
 */
import type { Db } from '../db/index.js';
import { auditEvents } from '../db/schema.js';
import type { Actor } from './actor.js';
import { isRegisteredAction } from './audit-catalog.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  previous?: unknown;
  next?: unknown;
  reason?: string | null;
  transactionId?: string | null;
}

export async function audit(tx: Db, actor: Pick<Actor, 'orgId' | 'requestId' | 'ip'> & { id?: string | null }, e: AuditInput): Promise<void> {
  if (!isRegisteredAction(e.action)) {
    // Every event type must be registered in audit-catalog.ts (it feeds the Activity filters). Loud in dev/test; never breaks a production request.
    const msg = `Unregistered audit action "${e.action}" — add it to src/lib/audit-catalog.ts`;
    if (process.env.NODE_ENV === 'production') console.error(JSON.stringify({ level: 'error', msg })); else throw new Error(msg);
  }
  await tx.insert(auditEvents).values({
    orgId: actor.orgId, actorUserId: actor.id ?? null,
    action: e.action, entityType: e.entityType, entityId: e.entityId,
    previous: e.previous ?? null, next: e.next ?? null,
    reason: e.reason ?? null, transactionId: e.transactionId ?? null,
    requestId: actor.requestId ?? null, ip: actor.ip ?? null,
  });
}

/**
 * Audit a SECURITY-relevant event that happens outside any business transaction (failed login, denied access…).
 * Best effort by design: a failure to write the log must never turn a 401/403 into a 500 or reveal anything to the caller.
 */
export async function auditSafe(db: Db, actor: Pick<Actor, 'orgId' | 'requestId' | 'ip'> & { id?: string | null }, e: AuditInput): Promise<void> {
  try { await audit(db, actor, e); } catch (err) { console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', action: e.action, err: String((err as Error).message).slice(0, 200) })); }
}
