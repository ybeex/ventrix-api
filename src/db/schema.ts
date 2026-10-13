/**
 * StoreKeeper schema — traced to PRD v3 sections (see `PRD §` tags).
 *
 * Conventions that recur everywhere (explained once, here):
 *
 * 1. TENANCY. Every business table carries `org_id`; every query filters by it. A
 *    foreign key proves a row *exists*, never that it's *yours* — every client-supplied
 *    reference is verified against the caller's org before it is written.
 *
 * 2. THE LEDGER IS THE TRUTH (PRD §11, §12, §63). `transactions` is append-only —
 *    a DB trigger (drizzle/manual/post/0100_immutability.sql) rejects UPDATE/DELETE.
 *    Every row carries signed deltas (`stock_delta`, `custody_delta`), so the guarded
 *    balance columns on `items` can be *proven* equal to the ledger sum
 *    (see modules/integrity). Mistakes are fixed by CORRECTION rows (PRD §50).
 *
 * 3. GUARDED STATE, NOT EDITABLE STATE. `items.quantity_available` / `asset_state` /
 *    `current_holder_id` are never writable through the API; only the transaction
 *    engine changes them, in the same DB transaction as the ledger row, using
 *    conditional UPDATEs. DB CHECK constraints are the last line of defence: a bug
 *    elsewhere still cannot produce negative stock or an asset "checked out" to nobody.
 *
 * 4. WHOLE-NUMBER QUANTITIES with a unit label (decision recorded with the PRD review).
 *
 * 5. PARTITION-READY. `transactions` and `audit_events` are the high-write append-only
 *    tables; both are keyed (org_id, created_at, id) for keyset pagination and can be
 *    range-partitioned by month later (DDL in docs/OPERATIONS.md).
 */
import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, timestamp, jsonb,
  uniqueIndex, index, primaryKey, check, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Enums ────────────────────────────────────────────────────────────
export const roleEnum = pgEnum('role', ['admin', 'supervisor', 'store_staff', 'viewer']); // PRD §31
export const itemTypeEnum = pgEnum('item_type', ['asset', 'consumable']); // PRD §7
// PRD §12 — exactly the six asset states.
export const assetStateEnum = pgEnum('asset_state', ['available', 'checked_out', 'lost', 'damaged', 'under_repair', 'retired']);
// PRD §15.2 — condition is a separate attribute from state (PRD §7.1 shows both).
export const conditionEnum = pgEnum('condition', ['good', 'damaged', 'needs_inspection', 'replaced']);
export const holderKindEnum = pgEnum('holder_kind', ['person', 'team', 'department', 'job_site', 'other']); // PRD §8
export const locationKindEnum = pgEnum('location_kind', ['store', 'site', 'warehouse', 'area']); // PRD §9
export const jobStatusEnum = pgEnum('job_status', ['active', 'closed']);
export const adjustmentReasonEnum = pgEnum('adjustment_reason', [ // PRD §18
  'count_correction', 'opening_balance_correction', 'unrecorded_movement', 'damage', 'loss', 'other',
]);
// PRD §11.1 — MVP set + the types promoted to core by §17/§19, + CORRECTION (PRD §24/§50) and RESTORE (PRD §51).
export const transactionTypeEnum = pgEnum('transaction_type', [
  'checkout', 'checkin', 'consume', 'restock', 'adjustment', 'create', 'archive', 'restore',
  'condition_update', 'loss', 'damage', 'reconciliation', 'correction',
]);
export const txSourceEnum = pgEnum('tx_source', ['online', 'sync']);
export const approvalModeEnum = pgEnum('approval_mode', ['direct', 'staff_approval', 'all_approval']); // PRD §18, §32
export const approvalOperationEnum = pgEnum('approval_operation', [
  'adjustment', 'loss', 'retirement', 'checkout', 'checkout_batch', 'checkin',
]);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'cancelled']);
export const reconciliationScopeEnum = pgEnum('reconciliation_scope', ['item', 'category', 'shelf', 'location']); // PRD §19 (+ shelf: "count against the shelf")
export const reconciliationStatusEnum = pgEnum('reconciliation_status', ['open', 'closed']);
export const importStatusEnum = pgEnum('import_status', ['uploaded', 'ready', 'committing', 'completed', 'failed']);
export const syncIssueKindEnum = pgEnum('sync_issue_kind', ['conflict', 'rejected']); // PRD §21 FAILED / CONFLICT
export const syncIssueStatusEnum = pgEnum('sync_issue_status', ['open', 'resolved_kept_server', 'resolved_applied_client']);
export const fileKindEnum = pgEnum('file_kind', ['item_photo', 'transaction_snapshot']); // PRD §23
export const sessionKindEnum = pgEnum('session_kind', ['primary', 'pin']);
export const tokenPurposeEnum = pgEnum('token_purpose', ['invite', 'password_reset']);
export const notificationTypeEnum = pgEnum('notification_type', [ // PRD §30
  'low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending', 'approval_decided',
  'announcement', 'cycle_count_due',
]);
export const announcementSeverityEnum = pgEnum('announcement_severity', ['info', 'warning', 'critical']);
export const emailStatusEnum = pgEnum('email_status', ['pending', 'sent', 'failed']);

const tstz = (name: string) => timestamp(name, { withTimezone: true });
// Truncated to milliseconds ON PURPOSE: keyset pagination round-trips created_at through a JS Date
// (millisecond precision). With Postgres' native microseconds a cursor would compare as "slightly earlier"
// than rows written in the same millisecond and silently skip them across a page boundary.
const createdAt = () => tstz('created_at').notNull().default(sql`date_trunc('milliseconds', now())`);

// ── Organizations & settings (PRD §33, §31) ─────────────────────────
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // Login resolves the org by slug first (email is unique per org, not globally).
  slug: text('slug').notNull(),
  // IANA zone — "today's transactions", due dates and reports are evaluated in the org's local day, not UTC.
  timezone: text('timezone').notNull().default('Africa/Lagos'),
  createdAt: createdAt(),
}, (t) => ({ slugUnique: uniqueIndex('organizations_slug_unique').on(t.slug) }));

export const organizationSettings = pgTable('organization_settings', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id),
  reconciliationRequireReason: boolean('reconciliation_require_reason').notNull().default(true), // PRD §56.4 "where configured"
  staffCanManageItems: boolean('staff_can_manage_items').notNull().default(false), // PRD §31: Admin manages items; configurable
  requirePhotoFor: jsonb('require_photo_for').$type<string[]>().notNull().default(sql`'[]'::jsonb`), // PRD §23 "unless configured by policy"
  notificationEmailTypes: jsonb('notification_email_types').$type<string[]>().notNull()
    .default(sql`'["approval_pending","overdue_checkout"]'::jsonb`), // PRD §30 "where configured, by email"
  dueSoonHours: integer('due_soon_hours').notNull().default(24), // PRD §27 Due vs Overdue window
  nearMinimumPercent: integer('near_minimum_percent').notNull().default(10), // "Close to minimum" band above the minimum; 0 disables
  supervisorsCanInvite: boolean('supervisors_can_invite').notNull().default(true), // role-based invites: supervisors may invite store staff and viewers
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// PRD §18, §32. Per-operation modes. direct: nobody needs approval. staff_approval: store_staff are queued;
// supervisor/admin commit directly. all_approval: everyone except admin is queued.
export const approvalPolicies = pgTable('approval_policies', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id),
  adjustmentMode: approvalModeEnum('adjustment_mode').notNull().default('staff_approval'),
  lossMode: approvalModeEnum('loss_mode').notNull().default('staff_approval'),
  retirementMode: approvalModeEnum('retirement_mode').notNull().default('staff_approval'),
  checkoutMode: approvalModeEnum('checkout_mode').notNull().default('direct'), // PRD §32: routine ops never need approval unless enabled
  checkinMode: approvalModeEnum('checkin_mode').notNull().default('direct'),
  // Adjustments with |delta| >= this escalate to all_approval even if the mode is looser ("large stock adjustments").
  largeAdjustmentThreshold: integer('large_adjustment_threshold'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

// ── Locations (PRD §9) ───────────────────────────────────────────────
export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  kind: locationKindEnum('kind').notNull().default('store'),
  parentId: uuid('parent_id').references((): AnyPgColumn => locations.id),
  address: text('address'),
  isDefault: boolean('is_default').notNull().default(false),
  archivedAt: tstz('archived_at'),
  createdAt: createdAt(),
}, (t) => ({
  byOrg: index('locations_org_idx').on(t.orgId),
  oneDefault: uniqueIndex('locations_one_default_per_org').on(t.orgId).where(sql`is_default and archived_at is null`),
}));

// ── Shelves → Categories → Items ─────────────────────────────────────
// The store's physical structure: a SHELF (in a location) holds CATEGORIES; a CATEGORY holds ITEMS. Strictly one parent at each
// level, enforced by NOT NULL foreign keys: no item without a category, no category without a shelf. An item's location is
// DERIVED from its shelf (items.location_id is kept equal to shelf.location_id by the services that move things).
export const shelves = pgTable('shelves', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  code: text('code').notNull(), // scannable shelf tag (QR); scanning it starts a count against the shelf
  description: text('description'),
  position: integer('position').notNull().default(0), // display order
  cycleCountDays: integer('cycle_count_days'), // recurring count reminder; null = none
  archivedAt: tstz('archived_at'),
  createdAt: createdAt(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => ({
  byOrg: index('shelves_org_idx').on(t.orgId, t.locationId),
  nameUnique: uniqueIndex('shelves_org_name_unique').on(t.orgId, sql`lower(${t.name})`).where(sql`archived_at is null`),
  codeUnique: uniqueIndex('shelves_org_code_unique').on(t.orgId, t.code),
  byUpdated: index('shelves_org_updated_idx').on(t.orgId, t.updatedAt),
}));

// ── Identity (PRD §37, §31) ──────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  passwordHash: text('password_hash'), // null until an invitation is accepted
  role: roleEnum('role').notNull().default('store_staff'),
  active: boolean('active').notNull().default(true),
  pinHash: text('pin_hash'), // quick-switch PIN for shared store devices (PRD §49); argon2id, never admin accounts
  pinFailedAttempts: integer('pin_failed_attempts').notNull().default(0),
  pinLockedUntil: tstz('pin_locked_until'),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  lastLoginAt: tstz('last_login_at'),
  invitedBy: uuid('invited_by'), // who sent the (still-open or accepted) invitation
  invitedAt: tstz('invited_at'),
  createdAt: createdAt(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => ({ orgEmailUnique: uniqueIndex('users_org_email_unique').on(t.orgId, t.email) }));

// One table for both invitation and password-reset tokens: random 256-bit, stored hashed, single-use, expiring.
export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  purpose: tokenPurposeEnum('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  usedAt: tstz('used_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => ({
  tokenHashUnique: uniqueIndex('auth_tokens_hash_unique').on(t.tokenHash),
  byUser: index('auth_tokens_user_idx').on(t.userId, t.purpose),
}));

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(), // sha256 of the bearer token; the raw token is never stored
  kind: sessionKindEnum('kind').notNull().default('primary'),
  trustedDevice: boolean('trusted_device').notNull().default(false), // may mint PIN sessions (supervisor/admin login only)
  deviceId: text('device_id'),
  parentSessionId: uuid('parent_session_id'),
  expiresAt: tstz('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, (t) => ({
  tokenHashUnique: uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
  byUser: index('sessions_user_idx').on(t.userId),
  byExpiry: index('sessions_expires_idx').on(t.expiresAt),
}));

// ── Jobs / project context (PRD §10) ─────────────────────────────────
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  code: text('code'),
  name: text('name').notNull(),
  status: jobStatusEnum('status').notNull().default('active'),
  archivedAt: tstz('archived_at'),
  createdAt: createdAt(),
}, (t) => ({
  byOrg: index('jobs_org_idx').on(t.orgId),
  codeUnique: uniqueIndex('jobs_org_code_unique').on(t.orgId, t.code).where(sql`code is not null and archived_at is null`),
}));

// ── Holders (PRD §8) ─────────────────────────────────────────────────
// One table for every kind of accountable party. A `person` holder may exist without a
// login (most workers never open the app) and may optionally link to a user account.
export const holders = pgTable('holders', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  kind: holderKindEnum('kind').notNull(),
  name: text('name').notNull(),
  code: text('code'), // badge / employee number
  userId: uuid('user_id').references(() => users.id),
  jobId: uuid('job_id').references(() => jobs.id),
  archivedAt: tstz('archived_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => ({
  byOrgKind: index('holders_org_kind_idx').on(t.orgId, t.kind),
  nameTrgm: index('holders_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  userUnique: uniqueIndex('holders_org_user_unique').on(t.orgId, t.userId).where(sql`user_id is not null`),
  personOnlyUser: check('holders_user_only_person', sql`user_id is null or kind = 'person'`),
}));

export const holderMembers = pgTable('holder_members', {
  teamId: uuid('team_id').notNull().references(() => holders.id),
  personId: uuid('person_id').notNull().references(() => holders.id),
}, (t) => ({ pk: primaryKey({ columns: [t.teamId, t.personId] }), byPerson: index('holder_members_person_idx').on(t.personId) }));

// ── Categories (PRD §6) ──────────────────────────────────────────────
export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  shelfId: uuid('shelf_id').notNull().references(() => shelves.id), // every category lives on exactly one shelf
  name: text('name').notNull(),
  codePrefix: text('code_prefix'), // drives human Item IDs, e.g. DRL -> DRL-0042
  defaultMinQuantity: integer('default_min_quantity'),
  defaultExpectedReturnHours: integer('default_expected_return_hours'), // PRD §27 category-level expected return
  archivedAt: tstz('archived_at'),
  createdAt: createdAt(),
}, (t) => ({
  byOrg: index('categories_org_idx').on(t.orgId),
  byShelf: index('categories_shelf_idx').on(t.orgId, t.shelfId),
  nameUnique: uniqueIndex('categories_org_name_unique').on(t.orgId, sql`lower(${t.name})`).where(sql`archived_at is null`),
  prefixShape: check('categories_prefix_shape', sql`code_prefix is null or code_prefix ~ '^[A-Z0-9]{2,6}$'`),
}));

// ── Files (PRD §23, §37) ─────────────────────────────────────────────
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  kind: fileKindEnum('kind').notNull(),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => ({ byOrg: index('files_org_idx').on(t.orgId) }));

// ── Per-org counters for human-readable Item IDs ────────────────────
export const itemCounters = pgTable('item_counters', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  prefix: text('prefix').notNull(),
  nextValue: integer('next_value').notNull().default(1),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.prefix] }) }));

// ── Items (PRD §6, §7, §12, §28) ─────────────────────────────────────
export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(), // system-generated unique identifier (PRD §6)
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  itemNumber: text('item_number').notNull(), // human-readable, e.g. DRL-0042 (PRD §7.1)
  type: itemTypeEnum('type').notNull(),
  sku: text('sku'), // external reference
  code: text('code').notNull(), // scannable QR/barcode value; defaults to item_number so every item is scannable
  name: text('name').notNull(),
  description: text('description'),
  categoryId: uuid('category_id').notNull().references(() => categories.id), // every item lives in exactly one category
  locationId: uuid('location_id').notNull().references(() => locations.id), // home location (PRD §9) — derived from category → shelf
  photoFileId: uuid('photo_file_id').references(() => files.id),
  unit: text('unit').notNull().default('pcs'),

  // Tracked Asset state (null for consumables) — guarded, only the transaction engine writes these.
  assetState: assetStateEnum('asset_state'),
  condition: conditionEnum('condition'),
  currentHolderId: uuid('current_holder_id').references(() => holders.id),
  currentJobId: uuid('current_job_id').references(() => jobs.id),
  checkedOutAt: tstz('checked_out_at'),
  dueAt: tstz('due_at'),
  expectedReturnHours: integer('expected_return_hours'), // PRD §27 asset-level override

  // Consumable state (null for assets) — guarded.
  quantityAvailable: integer('quantity_available'),
  minQuantity: integer('min_quantity'),
  reorderQuantity: integer('reorder_quantity'),

  archivedAt: tstz('archived_at'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => ({
  numberUnique: uniqueIndex('items_org_number_unique').on(t.orgId, t.itemNumber),
  skuUnique: uniqueIndex('items_org_sku_unique').on(t.orgId, t.sku).where(sql`sku is not null and archived_at is null`),
  codeUnique: uniqueIndex('items_org_code_unique').on(t.orgId, t.code).where(sql`archived_at is null`),
  byOrgCategory: index('items_org_category_idx').on(t.orgId, t.categoryId),
  byOrgUpdated: index('items_org_updated_idx').on(t.orgId, t.updatedAt),
  heldAssets: index('items_held_idx').on(t.orgId, t.currentHolderId).where(sql`asset_state = 'checked_out'`),
  dueAssets: index('items_due_idx').on(t.orgId, t.dueAt).where(sql`asset_state = 'checked_out'`),
  consumables: index('items_consumables_idx').on(t.orgId).where(sql`type = 'consumable' and archived_at is null`),
  nameTrgm: index('items_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  numberTrgm: index('items_number_trgm_idx').using('gin', sql`${t.itemNumber} gin_trgm_ops`),
  skuTrgm: index('items_sku_trgm_idx').using('gin', sql`${t.sku} gin_trgm_ops`),
  // Last line of defence — these hold even if application code is wrong.
  typeShape: check('items_type_shape', sql`(type = 'asset' and asset_state is not null and quantity_available is null)
    or (type = 'consumable' and asset_state is null and quantity_available is not null and current_holder_id is null)`),
  qtyNonNegative: check('items_qty_nonneg', sql`quantity_available is null or quantity_available >= 0`),
  holderMatchesState: check('items_holder_matches_state', sql`coalesce(asset_state = 'checked_out', false) = (current_holder_id is not null)`),
}));

// ── Transaction ledger (PRD §11, §24, §50) ───────────────────────────
export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Strictly monotonic insert order. created_at alone cannot order rows written in the SAME database
  // transaction (they share now()), e.g. a correction's reversal and its replacement. Lists page on seq.
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: transactionTypeEnum('type').notNull(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  quantity: integer('quantity'), // magnitude as entered; null for pure asset state events

  // Signed effects. stock_delta: effect on items.quantity_available. custody_delta: effect on the
  // holder's outstanding balance (+ on checkout, − on checkin; ±1 for assets).
  stockDelta: integer('stock_delta').notNull().default(0),
  custodyDelta: integer('custody_delta').notNull().default(0),
  // "Previous and new state" (PRD §24), recorded at write time because rows are never updated.
  balanceBefore: integer('balance_before'),
  balanceAfter: integer('balance_after'),
  stateBefore: assetStateEnum('state_before'),
  stateAfter: assetStateEnum('state_after'),

  // Actor and Holder are separate, independently queryable fields (PRD §8, mandatory).
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  holderId: uuid('holder_id').references(() => holders.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  jobId: uuid('job_id').references(() => jobs.id),

  condition: conditionEnum('condition'),
  reason: adjustmentReasonEnum('reason'),
  purpose: text('purpose'),
  note: text('note'),

  correctsTransactionId: uuid('corrects_transaction_id').references((): AnyPgColumn => transactions.id),
  relatedTransactionId: uuid('related_transaction_id').references((): AnyPgColumn => transactions.id),
  dueAt: tstz('due_at'), // checkout only: fixed at issue time so a later policy change never rewrites history
  snapshotFileId: uuid('snapshot_file_id').references(() => files.id), // PRD §23 transaction snapshot
  approvalId: uuid('approval_id'),
  approvedBy: uuid('approved_by').references(() => users.id),
  overrideAuthorizedBy: uuid('override_authorized_by').references(() => users.id),

  idempotencyKey: text('idempotency_key'),
  requestFingerprint: text('request_fingerprint'), // lets a replay detect "same key, different request"
  occurredAt: tstz('occurred_at').notNull().defaultNow(), // device-claimed time (offline queue); informational
  source: txSourceEnum('source').notNull().default('online'),
  deviceId: text('device_id'),
  metadata: jsonb('metadata'),
  createdAt: createdAt(), // server receive time — authoritative ordering
}, (t) => ({
  idempotencyUnique: uniqueIndex('tx_org_actor_idempotency_unique').on(t.orgId, t.actorUserId, t.idempotencyKey).where(sql`idempotency_key is not null`),
  oneReversalPerTx: uniqueIndex('tx_one_reversal_unique').on(t.correctsTransactionId).where(sql`type = 'correction'`),
  seqUnique: uniqueIndex('tx_seq_unique').on(t.seq),
  byItem: index('tx_item_seq_idx').on(t.itemId, t.seq), // item timeline
  byOrg: index('tx_org_seq_idx').on(t.orgId, t.seq), // activity / reports (keyset on seq)
  byOrgCreated: index('tx_org_created_idx').on(t.orgId, t.createdAt), // date-range filters
  byOrgType: index('tx_org_type_created_idx').on(t.orgId, t.type, t.createdAt),
  byHolder: index('tx_holder_idx').on(t.orgId, t.holderId, t.itemId).where(sql`custody_delta <> 0`), // outstanding balances
  byActor: index('tx_actor_created_idx').on(t.orgId, t.actorUserId, t.createdAt),
  holderRequired: check('tx_holder_required', sql`type not in ('checkout','checkin') or holder_id is not null`),
  correctionLinked: check('tx_correction_linked', sql`type <> 'correction' or corrects_transaction_id is not null`),
}));

// ── Approvals (PRD §18, §32) ─────────────────────────────────────────
export const pendingApprovals = pgTable('pending_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  operation: approvalOperationEnum('operation').notNull(),
  itemId: uuid('item_id').references(() => items.id),
  payload: jsonb('payload').notNull(), // the full validated request; re-validated against live state at approval time
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  status: approvalStatusEnum('status').notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: tstz('reviewed_at'),
  reviewNote: text('review_note'),
  resultingTransactionId: uuid('resulting_transaction_id').references(() => transactions.id),
  idempotencyKey: text('idempotency_key'),
  requestFingerprint: text('request_fingerprint'),
  createdAt: createdAt(),
}, (t) => ({
  byOrgStatus: index('approvals_org_status_idx').on(t.orgId, t.status, t.createdAt),
  idempotencyUnique: uniqueIndex('approvals_org_actor_idempotency_unique').on(t.orgId, t.requestedBy, t.idempotencyKey).where(sql`idempotency_key is not null`),
}));

// ── Reconciliation (PRD §19, §56.4) ──────────────────────────────────
export const reconciliations = pgTable('reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  scope: reconciliationScopeEnum('scope').notNull(),
  scopeId: uuid('scope_id').notNull(), // item / category / location id, verified against the org at creation
  status: reconciliationStatusEnum('status').notNull().default('open'),
  note: text('note'),
  startedBy: uuid('started_by').notNull().references(() => users.id),
  startedAt: tstz('started_at').notNull().defaultNow(),
  closedBy: uuid('closed_by').references(() => users.id),
  closedAt: tstz('closed_at'),
}, (t) => ({ byOrg: index('reconciliations_org_idx').on(t.orgId, t.startedAt) }));

// Rows are written once, complete (links included) and never updated — enforced by trigger.
export const reconciliationCounts = pgTable('reconciliation_counts', {
  id: uuid('id').primaryKey().defaultRandom(),
  reconciliationId: uuid('reconciliation_id').notNull().references(() => reconciliations.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  systemQuantity: integer('system_quantity').notNull(), // preserved original system quantity (PRD §56.4)
  physicalQuantity: integer('physical_quantity').notNull(),
  variance: integer('variance').notNull(), // physical − system, stored: an audit fact, not a view
  reason: text('reason'),
  note: text('note'),
  countedBy: uuid('counted_by').notNull().references(() => users.id),
  ledgerTransactionId: uuid('ledger_transaction_id').references(() => transactions.id),
  adjustmentTransactionId: uuid('adjustment_transaction_id').references(() => transactions.id),
  pendingApprovalId: uuid('pending_approval_id').references(() => pendingApprovals.id),
  snapshotFileId: uuid('snapshot_file_id').references(() => files.id),
  idempotencyKey: text('idempotency_key'),
  requestFingerprint: text('request_fingerprint'),
  createdAt: createdAt(),
}, (t) => ({
  byRecon: index('recon_counts_recon_idx').on(t.reconciliationId),
  byItem: index('recon_counts_item_idx').on(t.orgId, t.itemId, t.createdAt),
  idempotencyUnique: uniqueIndex('recon_counts_recon_idempotency_unique').on(t.reconciliationId, t.idempotencyKey).where(sql`idempotency_key is not null`),
}));

// ── CSV import (PRD §22) ─────────────────────────────────────────────
export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  fileName: text('file_name').notNull(),
  locationId: uuid('location_id').references(() => locations.id),
  headers: jsonb('headers'),
  rows: jsonb('rows'),
  columnMapping: jsonb('column_mapping'),
  status: importStatusEnum('status').notNull().default('uploaded'),
  totalRows: integer('total_rows'),
  importedRows: integer('imported_rows'),
  skippedRows: integer('skipped_rows'),
  failedRows: integer('failed_rows'),
  errorReport: jsonb('error_report'),
  startedBy: uuid('started_by').notNull().references(() => users.id),
  startedAt: tstz('started_at').notNull().defaultNow(),
  completedAt: tstz('completed_at'),
});

// ── Offline sync issues (PRD §21) ────────────────────────────────────
export const syncIssues = pgTable('sync_issues', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  kind: syncIssueKindEnum('kind').notNull(),
  deviceId: text('device_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  clientGeneratedId: text('client_generated_id').notNull(),
  operation: text('operation').notNull(),
  itemId: uuid('item_id'),
  payload: jsonb('payload').notNull(),
  code: text('code').notNull(),
  message: text('message').notNull(),
  status: syncIssueStatusEnum('status').notNull().default('open'),
  resolutionNote: text('resolution_note'),
  resultingTransactionId: uuid('resulting_transaction_id').references(() => transactions.id),
  detectedAt: tstz('detected_at').notNull().defaultNow(),
  resolvedAt: tstz('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
}, (t) => ({
  byOrgStatus: index('sync_issues_org_status_idx').on(t.orgId, t.status, t.detectedAt),
  // A retried batch must not create a second issue row for the same queued action.
  clientActionUnique: uniqueIndex('sync_issues_client_action_unique').on(t.orgId, t.deviceId, t.clientGeneratedId),
}));

// ── Notifications (PRD §30) & transactional outbox ───────────────────
export const domainEvents = pgTable('domain_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  dedupeKey: text('dedupe_key'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  processedAt: tstz('processed_at'),
  createdAt: createdAt(),
}, (t) => ({
  pending: index('domain_events_pending_idx').on(t.createdAt).where(sql`processed_at is null`),
  dedupe: uniqueIndex('domain_events_dedupe_unique').on(t.orgId, t.dedupeKey).where(sql`dedupe_key is not null`),
}));

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  type: notificationTypeEnum('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  dedupeKey: text('dedupe_key'),
  readAt: tstz('read_at'),
  createdAt: createdAt(),
}, (t) => ({
  byUser: index('notifications_user_idx').on(t.userId, t.createdAt, t.id),
  dedupe: uniqueIndex('notifications_user_dedupe_unique').on(t.userId, t.dedupeKey).where(sql`dedupe_key is not null`),
}));

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').notNull().references(() => users.id),
  type: notificationTypeEnum('type').notNull(),
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email'), // null = follow the org default
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.type] }) }));

// Outbound email, written in the same transaction as the thing that caused it and sent by a worker
// through the Mailgun circuit breaker — a Mailgun outage can delay mail but never lose it or block a request.
// Which roles receive each kind of system notification (default: admin + supervisor). approval_decided always goes to the requester.
export const notificationRules = pgTable('notification_rules', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: notificationTypeEnum('type').notNull(),
  roles: jsonb('roles').$type<string[]>().notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.type] }) }));

// Org-wide broadcasts to chosen roles (empty audience = everyone). Delivered as notifications (+ optional e-mail) through the event outbox.
export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  title: text('title').notNull(),
  body: text('body').notNull(),
  severity: announcementSeverityEnum('severity').notNull().default('info'),
  audienceRoles: jsonb('audience_roles').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  sendEmail: boolean('send_email').notNull().default(false),
  publishedBy: uuid('published_by').notNull().references(() => users.id),
  expiresAt: tstz('expires_at'),
  retractedAt: tstz('retracted_at'),
  createdAt: createdAt(),
}, (t) => ({ byOrg: index('announcements_org_idx').on(t.orgId, t.createdAt) }));

export const emailOutbox = pgTable('email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  toEmail: text('to_email').notNull(),
  subject: text('subject').notNull(),
  textBody: text('text_body').notNull(),
  htmlBody: text('html_body'),
  status: emailStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: tstz('next_attempt_at').notNull().defaultNow(),
  sentAt: tstz('sent_at'),
  createdAt: createdAt(),
}, (t) => ({ due: index('email_outbox_due_idx').on(t.nextAttemptAt).where(sql`status = 'pending'`) }));

// ── Audit log (PRD §24) ──────────────────────────────────────────────
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(), // e.g. 'transaction.checkout', 'user.role_changed', 'policy.updated'
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  previous: jsonb('previous'),
  next: jsonb('next'),
  reason: text('reason'),
  transactionId: uuid('transaction_id').references(() => transactions.id),
  requestId: text('request_id'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => ({
  seqUnique: uniqueIndex('audit_seq_unique').on(t.seq),
  byOrg: index('audit_org_seq_idx').on(t.orgId, t.seq),
  byOrgCreated: index('audit_org_created_idx').on(t.orgId, t.createdAt),
  byEntity: index('audit_entity_idx').on(t.orgId, t.entityType, t.entityId, t.seq),
  byAction: index('audit_action_idx').on(t.orgId, t.action, t.seq),
  byActor: index('audit_actor_idx').on(t.orgId, t.actorUserId, t.seq),
}));

// ── Cross-request idempotency for non-ledger writes ──────────────────
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  key: text('key').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  lockedAt: tstz('locked_at').notNull().defaultNow(),
  createdAt: createdAt(),
  expiresAt: tstz('expires_at').notNull(),
}, (t) => ({
  orgActorKeyUnique: uniqueIndex('idem_org_actor_key_unique').on(t.orgId, t.actorUserId, t.key),
  byExpiry: index('idem_expires_idx').on(t.expiresAt),
}));
