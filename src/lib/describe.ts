/**
 * Plain-language sentences for the Activity feed and item timelines ("Ben checked out Angle grinder 12 to Electrical team").
 * Pure functions: the same ledger row always reads the same way, on every surface (API, CSV, notifications).
 */
import { AUDIT_ACTIONS, humanizeAction } from './audit-catalog.js';

const STATE: Record<string, string> = { available: 'available', checked_out: 'checked out', lost: 'lost', damaged: 'damaged', under_repair: 'under repair', retired: 'retired' };
const REASON: Record<string, string> = { count_correction: 'count correction', opening_balance_correction: 'opening balance correction', unrecorded_movement: 'unrecorded movement', damage: 'damage', loss: 'loss', other: 'other' };
const ROLE: Record<string, string> = { admin: 'an admin', supervisor: 'a supervisor', store_staff: 'store staff', viewer: 'a viewer' };
const state = (s?: string | null) => (s ? STATE[s] ?? s.replace(/_/g, ' ') : 'unknown');

export interface TxFacts {
  type: string; quantity: number | null; stockDelta: number; custodyDelta: number; stateBefore: string | null; stateAfter: string | null;
  condition: string | null; reason: string | null; balanceBefore: number | null; balanceAfter: number | null;
}
export interface Who { actor: string | null; item: string | null; holder: string | null }

export function summarizeTx(t: TxFacts, w: Who): string {
  const a = w.actor ?? 'Someone';
  const item = w.item ?? 'an item';
  const q = t.stockDelta !== 0 && t.quantity ? `${t.quantity} ` : '';
  const holder = w.holder;
  switch (t.type) {
    case 'checkout': return `${a} checked out ${q}${item}${holder ? ` to ${holder}` : ''}`;
    case 'checkin': return `${a} returned ${q}${item}${holder ? ` from ${holder}` : ''}${t.condition && t.condition !== 'good' ? ` (condition: ${t.condition.replace(/_/g, ' ')})` : ''}`;
    case 'consume': return `${a} used ${q}${item}${holder ? ` for ${holder}` : ''}`;
    case 'restock': return `${a} added ${q}${item} to stock`;
    case 'adjustment': return `${a} adjusted ${item} by ${t.stockDelta > 0 ? '+' : ''}${t.stockDelta}${t.reason ? ` (${REASON[t.reason] ?? t.reason})` : ''}`;
    case 'loss': return t.stockDelta !== 0 ? `${a} wrote off ${q}${item} as lost` : `${a} declared ${item} lost${holder ? ` while with ${holder}` : ''}`;
    case 'damage': return t.stockDelta !== 0 ? `${a} wrote off ${q}${item} as damaged` : `${a} reported ${item} damaged${holder ? ` while with ${holder}` : ''}`;
    case 'condition_update': return `${a} changed ${item} from ${state(t.stateBefore)} to ${state(t.stateAfter)}`;
    case 'create': return `${a} added ${item} to the catalogue${t.stockDelta > 0 ? ` with ${t.stockDelta} in stock` : ''}`;
    case 'archive': return `${a} archived ${item}`;
    case 'restore': return `${a} restored ${item}`;
    case 'reconciliation': return `${a} counted ${item}: ${t.quantity ?? '?'} found${t.balanceBefore !== null ? `, ${t.balanceBefore} expected` : ''}`;
    case 'correction': return `${a} corrected an earlier entry on ${item}`;
    default: return `${a} recorded ${t.type.replace(/_/g, ' ')} on ${item}`;
  }
}

export interface AuditFacts { action: string; previous: any; next: any; reason: string | null }
export interface AuditWho { actor: string | null; entity: string | null }

export function summarizeAudit(e: AuditFacts, w: AuditWho): string {
  const a = w.actor ?? 'Someone';
  const n = e.next ?? {};
  const p = e.previous ?? {};
  const ent = w.entity;
  switch (e.action) {
    case 'user.invited': return `${a} invited ${n.email ?? 'a user'} as ${ROLE[n.role] ?? n.role}`;
    case 'user.invite_resent': return `${a} re-sent an invitation${ent ? ` to ${ent}` : ''}`;
    case 'user.invite_revoked': return `${a} revoked the invitation${ent ? ` for ${ent}` : ''}`;
    case 'user.invite_accepted': return `${a} accepted their invitation and joined`;
    case 'user.role_changed': return `${a} changed ${ent ? `${ent}'s` : 'a user\'s'} role from ${p.role ?? '?'} to ${n.role ?? '?'}`;
    case 'user.deactivated': return `${a} deactivated ${ent ?? 'a user'}`;
    case 'user.reactivated': return `${a} reactivated ${ent ?? 'a user'}`;
    case 'user.password_reset': return `${ent ?? a} reset their password`;
    case 'auth.login': return `${a} signed in${n.deviceId ? ` on ${n.deviceId}` : ''}`;
    case 'auth.login_failed': return `Failed sign-in${ent ? ` for ${ent}` : ''} (${String(n.reason ?? 'unknown').replace(/_/g, ' ')})`;
    case 'auth.account_locked': return `${ent ?? 'An account'} was locked for ${n.minutes ?? 15} minutes after ${n.after ?? 5} failed attempts`;
    case 'auth.logout': return `${a} signed out`;
    case 'auth.logout_all': return `${a} signed out of all devices`;
    case 'auth.pin_switch': return `${a} switched in by PIN${n.deviceId ? ` on ${n.deviceId}` : ''}`;
    case 'auth.pin_failed': return `Failed PIN attempt${ent ? ` for ${ent}` : ''}`;
    case 'auth.password_reset_requested': return `A password reset was requested${ent ? ` for ${ent}` : ''}`;
    case 'access.denied': return `${a} was refused access to ${e.next?.permission ? `"${n.permission}"` : 'a protected action'}`;
    case 'session.revoked': return n.own ? `${a} signed out one of their own devices` : n.allDevices ? `${a} signed out ${ent ?? 'a user'} everywhere (${n.sessions ?? 0} session${n.sessions === 1 ? '' : 's'})` : `${a} signed out a session of ${ent ?? 'a user'}`;
    case 'shelf.created': return `${a} created shelf ${n.name ?? ent ?? ''}`.trim();
    case 'shelf.updated': return `${a} edited shelf ${ent ?? n.name ?? ''}${n.itemsRelocated ? ` and relocated ${n.itemsRelocated} items` : ''}`.trim();
    case 'shelf.archived': return `${a} archived shelf ${ent ?? p.name ?? ''}`.trim();
    case 'shelf.restored': return `${a} restored shelf ${ent ?? ''}`.trim();
    case 'category.created': return `${a} created category ${n.name ?? ent ?? ''}`.trim();
    case 'category.updated': return `${a} edited category ${ent ?? n.name ?? ''}`.trim();
    case 'category.moved': return `${a} moved category ${ent ?? ''} to another shelf${n.itemsRelocated ? ` (${n.itemsRelocated} items relocated)` : ''}`.replace('  ', ' ');
    case 'category.archived': return `${a} archived category ${ent ?? p.name ?? ''}`.trim();
    case 'category.restored': return `${a} restored category ${ent ?? ''}`.trim();
    case 'item.updated': return `${a} edited ${ent ?? 'an item'} (${Object.keys(n).join(', ') || 'details'})`;
    case 'item.moved': return `${a} moved ${ent ?? 'an item'} to another category`;
    case 'holder.created': return `${a} added ${n.kind === 'person' ? 'person' : n.kind ?? 'holder'} ${n.name ?? ent ?? ''}`.trim();
    case 'holder.updated': return `${a} edited ${ent ?? 'a holder'}`;
    case 'holder.archived': return `${a} archived ${ent ?? 'a holder'}`;
    case 'holder.members_set': return `${a} changed the members of ${ent ?? 'a team'}`;
    case 'policy.updated': return `${a} changed the approval policy`;
    case 'settings.updated': return `${a} changed organization settings`;
    case 'org.updated': return `${a} edited the organization`;
    case 'org.registered': return `${a} created the organization`;
    case 'notification.rules_changed': return `${a} changed who receives "${String(n.type ?? '').replace(/_/g, ' ')}" notifications`;
    case 'notification.preferences_changed': return `${a} changed their notification preferences`;
    case 'announcement.published': return `${a} published the announcement "${n.title ?? ent ?? ''}"`;
    case 'announcement.updated': return `${a} edited the announcement "${ent ?? ''}"`;
    case 'announcement.retracted': return `${a} retracted the announcement "${ent ?? ''}"`;
    case 'approval.requested': return `${a} requested approval to ${String(n.operation ?? 'act').replace(/_/g, ' ')}`;
    case 'approval.approved': return `${a} approved a request${e.reason ? `: ${e.reason}` : ''}`;
    case 'approval.rejected': return `${a} rejected a request${e.reason ? `: ${e.reason}` : ''}`;
    case 'approval.cancelled': return `${a} withdrew a request`;
    case 'reconciliation.started': return `${a} started a ${n.scope ?? ''} count`.replace('  ', ' ');
    case 'reconciliation.count_recorded': return `${a} recorded a count (${p.systemQuantity ?? '?'} expected, ${n.physicalQuantity ?? '?'} found)`;
    case 'reconciliation.closed': return `${a} closed a count`;
    case 'sync.conflict': return `An offline action from ${n.deviceId ?? 'a device'} conflicted (${n.code})`;
    case 'sync.rejected': return `An offline action from ${n.deviceId ?? 'a device'} was rejected (${n.code})`;
    case 'sync.resolved': return `${a} resolved a sync issue (${String(n.resolution ?? '').replace(/_/g, ' ')})`;
    case 'import.uploaded': return `${a} uploaded ${n.fileName ?? 'a file'} for import (${n.rows ?? '?'} rows)`;
    case 'import.validated': return `${a} validated an import (${n.valid ?? '?'} ready, ${n.invalid ?? 0} invalid, ${n.duplicates ?? 0} duplicates)`;
    case 'import.committed': return `${a} imported ${n.imported ?? '?'} items`;
    case 'file.uploaded': return `${a} uploaded a ${String(n.kind ?? '').replace(/_/g, ' ')}`.trim();
    case 'report.viewed': return `${a} viewed the ${ent ?? 'a'} report`;
    case 'report.exported': return `${a} exported the ${ent ?? ''} report`.replace('  ', ' ');
    case 'activity.viewed': return `${a} viewed the activity log`;
    default: return `${a}: ${AUDIT_ACTIONS[e.action]?.label ?? humanizeAction(e.action)}${ent ? ` — ${ent}` : ''}`;
  }
}
