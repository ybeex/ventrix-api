/**
 * The registry of every event the audit log can contain: a human label and a category (for the Activity filter UI).
 * `audit()` refuses an action that is not listed here (throws in dev/test, logs in production), so "every action is
 * monitored" is enforced by construction: a new feature cannot log an event nobody registered, and the filter UI can
 * always offer the full, accurate list (GET /activity/actions).
 */
export interface ActionInfo { label: string; category: AuditCategory }
export type AuditCategory = 'Inventory' | 'Approvals' | 'Counts' | 'Catalog' | 'People & access' | 'Settings' | 'Offline sync' | 'Imports & files' | 'Notifications' | 'Reporting' | 'Security';

const A = (category: AuditCategory, label: string): ActionInfo => ({ category, label });

export const AUDIT_ACTIONS: Record<string, ActionInfo> = {
  // Inventory ledger (every row also writes one of these — see transaction.*)
  'transaction.checkout': A('Inventory', 'Item checked out'), 'transaction.checkin': A('Inventory', 'Item returned'), 'transaction.consume': A('Inventory', 'Stock used'),
  'transaction.restock': A('Inventory', 'Stock added'), 'transaction.adjustment': A('Inventory', 'Stock adjusted'), 'transaction.loss': A('Inventory', 'Loss declared'),
  'transaction.damage': A('Inventory', 'Damage reported'), 'transaction.condition_update': A('Inventory', 'Condition or state changed'), 'transaction.create': A('Inventory', 'Item added'),
  'transaction.archive': A('Inventory', 'Item archived'), 'transaction.restore': A('Inventory', 'Item restored'), 'transaction.reconciliation': A('Inventory', 'Item counted'),
  'transaction.correction': A('Inventory', 'Entry corrected'),
  'item.updated': A('Catalog', 'Item details edited'), 'item.moved': A('Catalog', 'Item moved to another category'),
  // Approvals
  'approval.requested': A('Approvals', 'Approval requested'), 'approval.approved': A('Approvals', 'Request approved'), 'approval.rejected': A('Approvals', 'Request rejected'), 'approval.cancelled': A('Approvals', 'Request cancelled'),
  // Counts
  'reconciliation.started': A('Counts', 'Count started'), 'reconciliation.count_recorded': A('Counts', 'Count recorded'), 'reconciliation.closed': A('Counts', 'Count closed'),
  // Catalog structure
  'shelf.created': A('Catalog', 'Shelf created'), 'shelf.updated': A('Catalog', 'Shelf edited'), 'shelf.archived': A('Catalog', 'Shelf archived'), 'shelf.restored': A('Catalog', 'Shelf restored'),
  'category.created': A('Catalog', 'Category created'), 'category.updated': A('Catalog', 'Category edited'), 'category.moved': A('Catalog', 'Category moved to another shelf'),
  'category.archived': A('Catalog', 'Category archived'), 'category.restored': A('Catalog', 'Category restored'),
  'holder.created': A('Catalog', 'Holder created'), 'holder.updated': A('Catalog', 'Holder edited'), 'holder.archived': A('Catalog', 'Holder archived'), 'holder.members_set': A('Catalog', 'Team members changed'),
  'job.created': A('Catalog', 'Job created'), 'job.updated': A('Catalog', 'Job edited'), 'job.archived': A('Catalog', 'Job archived'),
  'location.created': A('Catalog', 'Location created'), 'location.updated': A('Catalog', 'Location edited'), 'location.archived': A('Catalog', 'Location archived'),
  // People & access
  'org.registered': A('People & access', 'Organization created'), 'user.invited': A('People & access', 'User invited'), 'user.invite_resent': A('People & access', 'Invitation re-sent'),
  'user.invite_revoked': A('People & access', 'Invitation revoked'), 'user.invite_accepted': A('People & access', 'Invitation accepted'), 'user.deactivated': A('People & access', 'User deactivated'),
  'user.reactivated': A('People & access', 'User reactivated'), 'user.role_changed': A('People & access', 'User role changed'), 'user.password_reset': A('People & access', 'Password reset'),
  'user.pin_set': A('People & access', 'PIN set'), 'user.pin_cleared': A('People & access', 'PIN cleared'), 'session.revoked': A('People & access', 'Session revoked'),
  // Settings
  'org.updated': A('Settings', 'Organization edited'), 'settings.updated': A('Settings', 'Settings changed'), 'policy.updated': A('Settings', 'Approval policy changed'),
  'notification.rules_changed': A('Settings', 'Notification routing changed'),
  // Offline sync
  'sync.conflict': A('Offline sync', 'Offline action conflicted'), 'sync.rejected': A('Offline sync', 'Offline action rejected'), 'sync.resolved': A('Offline sync', 'Sync issue resolved'),
  // Imports & files
  'import.uploaded': A('Imports & files', 'Import file uploaded'), 'import.validated': A('Imports & files', 'Import validated'), 'import.committed': A('Imports & files', 'Import committed'), 'file.uploaded': A('Imports & files', 'File uploaded'),
  // Notifications
  'announcement.published': A('Notifications', 'Announcement published'), 'announcement.updated': A('Notifications', 'Announcement edited'), 'announcement.retracted': A('Notifications', 'Announcement retracted'),
  'notification.preferences_changed': A('Notifications', 'Notification preferences changed'),
  // Reporting (reads of sensitive data are logged too)
  'report.viewed': A('Reporting', 'Report viewed'), 'report.exported': A('Reporting', 'Data exported'), 'activity.viewed': A('Reporting', 'Activity log viewed'),
  // Security
  'auth.login': A('Security', 'Signed in'), 'auth.login_failed': A('Security', 'Failed sign-in'), 'auth.account_locked': A('Security', 'Account locked after repeated failures'),
  'auth.logout': A('Security', 'Signed out'), 'auth.logout_all': A('Security', 'Signed out everywhere'), 'auth.pin_switch': A('Security', 'Switched user by PIN'), 'auth.pin_failed': A('Security', 'Failed PIN'),
  'auth.password_reset_requested': A('Security', 'Password reset requested'), 'access.denied': A('Security', 'Access denied'),
};

export const isRegisteredAction = (a: string) => a in AUDIT_ACTIONS;
export const humanizeAction = (a: string) => AUDIT_ACTIONS[a]?.label ?? a.replace(/[._]/g, ' ');
