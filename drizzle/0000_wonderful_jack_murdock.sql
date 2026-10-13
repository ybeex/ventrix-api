CREATE TYPE "public"."adjustment_reason" AS ENUM('count_correction', 'opening_balance_correction', 'unrecorded_movement', 'damage', 'loss', 'other');--> statement-breakpoint
CREATE TYPE "public"."approval_mode" AS ENUM('direct', 'staff_approval', 'all_approval');--> statement-breakpoint
CREATE TYPE "public"."approval_operation" AS ENUM('adjustment', 'loss', 'retirement', 'checkout', 'checkout_batch', 'checkin');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."asset_state" AS ENUM('available', 'checked_out', 'lost', 'damaged', 'under_repair', 'retired');--> statement-breakpoint
CREATE TYPE "public"."condition" AS ENUM('good', 'damaged', 'needs_inspection', 'replaced');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('item_photo', 'transaction_snapshot');--> statement-breakpoint
CREATE TYPE "public"."holder_kind" AS ENUM('person', 'team', 'department', 'job_site', 'other');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'ready', 'committing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."item_type" AS ENUM('asset', 'consumable');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('store', 'site', 'warehouse', 'area');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending', 'approval_decided');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_scope" AS ENUM('item', 'category', 'location');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'supervisor', 'store_staff', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('primary', 'pin');--> statement-breakpoint
CREATE TYPE "public"."sync_issue_kind" AS ENUM('conflict', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."sync_issue_status" AS ENUM('open', 'resolved_kept_server', 'resolved_applied_client');--> statement-breakpoint
CREATE TYPE "public"."token_purpose" AS ENUM('invite', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('checkout', 'checkin', 'consume', 'restock', 'adjustment', 'create', 'archive', 'restore', 'condition_update', 'loss', 'damage', 'reconciliation', 'correction');--> statement-breakpoint
CREATE TYPE "public"."tx_source" AS ENUM('online', 'sync');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"adjustment_mode" "approval_mode" DEFAULT 'staff_approval' NOT NULL,
	"loss_mode" "approval_mode" DEFAULT 'staff_approval' NOT NULL,
	"retirement_mode" "approval_mode" DEFAULT 'staff_approval' NOT NULL,
	"checkout_mode" "approval_mode" DEFAULT 'direct' NOT NULL,
	"checkin_mode" "approval_mode" DEFAULT 'direct' NOT NULL,
	"large_adjustment_threshold" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"previous" jsonb,
	"next" jsonb,
	"reason" text,
	"transaction_id" uuid,
	"request_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code_prefix" text,
	"default_min_quantity" integer,
	"default_expected_return_hours" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "categories_prefix_shape" CHECK (code_prefix is null or code_prefix ~ '^[A-Z0-9]{2,6}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "file_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "holder_members" (
	"team_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "holder_members_team_id_person_id_pk" PRIMARY KEY("team_id","person_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "holders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "holder_kind" NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"user_id" uuid,
	"job_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holders_user_only_person" CHECK (user_id is null or kind = 'person')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"location_id" uuid,
	"headers" jsonb,
	"rows" jsonb,
	"column_mapping" jsonb,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"total_rows" integer,
	"imported_rows" integer,
	"skipped_rows" integer,
	"failed_rows" integer,
	"error_report" jsonb,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_counters" (
	"org_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "item_counters_org_id_prefix_pk" PRIMARY KEY("org_id","prefix")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_number" text NOT NULL,
	"type" "item_type" NOT NULL,
	"sku" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"location_id" uuid NOT NULL,
	"photo_file_id" uuid,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"asset_state" "asset_state",
	"condition" "condition",
	"current_holder_id" uuid,
	"current_job_id" uuid,
	"checked_out_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"expected_return_hours" integer,
	"quantity_available" integer,
	"min_quantity" integer,
	"reorder_quantity" integer,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_type_shape" CHECK ((type = 'asset' and asset_state is not null and quantity_available is null)
    or (type = 'consumable' and asset_state is null and quantity_available is not null and current_holder_id is null)),
	CONSTRAINT "items_qty_nonneg" CHECK (quantity_available is null or quantity_available >= 0),
	CONSTRAINT "items_holder_matches_state" CHECK (coalesce(asset_state = 'checked_out', false) = (current_holder_id is not null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"status" "job_status" DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "location_kind" DEFAULT 'store' NOT NULL,
	"parent_id" uuid,
	"address" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean,
	CONSTRAINT "notification_preferences_user_id_type_pk" PRIMARY KEY("user_id","type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"reconciliation_require_reason" boolean DEFAULT true NOT NULL,
	"staff_can_manage_items" boolean DEFAULT false NOT NULL,
	"require_photo_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notification_email_types" jsonb DEFAULT '["approval_pending","overdue_checkout"]'::jsonb NOT NULL,
	"due_soon_hours" integer DEFAULT 24 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"operation" "approval_operation" NOT NULL,
	"item_id" uuid,
	"payload" jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"resulting_transaction_id" uuid,
	"idempotency_key" text,
	"request_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"system_quantity" integer NOT NULL,
	"physical_quantity" integer NOT NULL,
	"variance" integer NOT NULL,
	"reason" text,
	"note" text,
	"counted_by" uuid NOT NULL,
	"ledger_transaction_id" uuid,
	"adjustment_transaction_id" uuid,
	"pending_approval_id" uuid,
	"snapshot_file_id" uuid,
	"idempotency_key" text,
	"request_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope" "reconciliation_scope" NOT NULL,
	"scope_id" uuid NOT NULL,
	"status" "reconciliation_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"kind" "session_kind" DEFAULT 'primary' NOT NULL,
	"trusted_device" boolean DEFAULT false NOT NULL,
	"device_id" text,
	"parent_session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "sync_issue_kind" NOT NULL,
	"device_id" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"client_generated_id" text NOT NULL,
	"operation" text NOT NULL,
	"item_id" uuid,
	"payload" jsonb NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"status" "sync_issue_status" DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"resulting_transaction_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer,
	"stock_delta" integer DEFAULT 0 NOT NULL,
	"custody_delta" integer DEFAULT 0 NOT NULL,
	"balance_before" integer,
	"balance_after" integer,
	"state_before" "asset_state",
	"state_after" "asset_state",
	"actor_user_id" uuid NOT NULL,
	"holder_id" uuid,
	"location_id" uuid NOT NULL,
	"job_id" uuid,
	"condition" "condition",
	"reason" "adjustment_reason",
	"purpose" text,
	"note" text,
	"corrects_transaction_id" uuid,
	"related_transaction_id" uuid,
	"due_at" timestamp with time zone,
	"snapshot_file_id" uuid,
	"approval_id" uuid,
	"approved_by" uuid,
	"override_authorized_by" uuid,
	"idempotency_key" text,
	"request_fingerprint" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "tx_source" DEFAULT 'online' NOT NULL,
	"device_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tx_holder_required" CHECK (type not in ('checkout','checkin') or holder_id is not null),
	CONSTRAINT "tx_correction_linked" CHECK (type <> 'correction' or corrects_transaction_id is not null)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" "role" DEFAULT 'store_staff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"pin_hash" text,
	"pin_failed_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holder_members" ADD CONSTRAINT "holder_members_team_id_holders_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."holders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holder_members" ADD CONSTRAINT "holder_members_person_id_holders_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."holders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holders" ADD CONSTRAINT "holders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holders" ADD CONSTRAINT "holders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holders" ADD CONSTRAINT "holders_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "holders" ADD CONSTRAINT "holders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_counters" ADD CONSTRAINT "item_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_photo_file_id_files_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_current_holder_id_holders_id_fk" FOREIGN KEY ("current_holder_id") REFERENCES "public"."holders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_current_job_id_jobs_id_fk" FOREIGN KEY ("current_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locations" ADD CONSTRAINT "locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_locations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_resulting_transaction_id_transactions_id_fk" FOREIGN KEY ("resulting_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_ledger_transaction_id_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_adjustment_transaction_id_transactions_id_fk" FOREIGN KEY ("adjustment_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_pending_approval_id_pending_approvals_id_fk" FOREIGN KEY ("pending_approval_id") REFERENCES "public"."pending_approvals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliation_counts" ADD CONSTRAINT "reconciliation_counts_snapshot_file_id_files_id_fk" FOREIGN KEY ("snapshot_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_resulting_transaction_id_transactions_id_fk" FOREIGN KEY ("resulting_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_holder_id_holders_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."holders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_corrects_transaction_id_transactions_id_fk" FOREIGN KEY ("corrects_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_related_transaction_id_transactions_id_fk" FOREIGN KEY ("related_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_snapshot_file_id_files_id_fk" FOREIGN KEY ("snapshot_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_override_authorized_by_users_id_fk" FOREIGN KEY ("override_authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_org_created_idx" ON "audit_events" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_entity_idx" ON "audit_events" USING btree ("org_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_action_idx" ON "audit_events" USING btree ("org_id","action","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_actor_idx" ON "audit_events" USING btree ("org_id","actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_tokens_hash_unique" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_tokens_user_idx" ON "auth_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categories_org_idx" ON "categories" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_org_name_unique" ON "categories" USING btree ("org_id",lower("name")) WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_events_pending_idx" ON "domain_events" USING btree ("created_at") WHERE processed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "domain_events_dedupe_unique" ON "domain_events" USING btree ("org_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_due_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_org_idx" ON "files" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holder_members_person_idx" ON "holder_members" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holders_org_kind_idx" ON "holders" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "holders_name_trgm_idx" ON "holders" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "holders_org_user_unique" ON "holders" USING btree ("org_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idem_org_actor_key_unique" ON "idempotency_keys" USING btree ("org_id","actor_user_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idem_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_org_number_unique" ON "items" USING btree ("org_id","item_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_org_sku_unique" ON "items" USING btree ("org_id","sku") WHERE sku is not null and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_org_code_unique" ON "items" USING btree ("org_id","code") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_org_category_idx" ON "items" USING btree ("org_id","category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_org_updated_idx" ON "items" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_held_idx" ON "items" USING btree ("org_id","current_holder_id") WHERE asset_state = 'checked_out';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_due_idx" ON "items" USING btree ("org_id","due_at") WHERE asset_state = 'checked_out';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_consumables_idx" ON "items" USING btree ("org_id") WHERE type = 'consumable' and archived_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_name_trgm_idx" ON "items" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_number_trgm_idx" ON "items" USING gin ("item_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_sku_trgm_idx" ON "items" USING gin ("sku" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_org_idx" ON "jobs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_org_code_unique" ON "jobs" USING btree ("org_id","code") WHERE code is not null and archived_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_org_idx" ON "locations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locations_one_default_per_org" ON "locations" USING btree ("org_id") WHERE is_default and archived_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_user_dedupe_unique" ON "notifications" USING btree ("user_id","dedupe_key") WHERE dedupe_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_org_status_idx" ON "pending_approvals" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_org_actor_idempotency_unique" ON "pending_approvals" USING btree ("org_id","requested_by","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recon_counts_recon_idx" ON "reconciliation_counts" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recon_counts_item_idx" ON "reconciliation_counts" USING btree ("org_id","item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recon_counts_recon_idempotency_unique" ON "reconciliation_counts" USING btree ("reconciliation_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliations_org_idx" ON "reconciliations" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_issues_org_status_idx" ON "sync_issues" USING btree ("org_id","status","detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_issues_client_action_unique" ON "sync_issues" USING btree ("org_id","device_id","client_generated_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tx_org_actor_idempotency_unique" ON "transactions" USING btree ("org_id","actor_user_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tx_one_reversal_unique" ON "transactions" USING btree ("corrects_transaction_id") WHERE type = 'correction';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_item_created_idx" ON "transactions" USING btree ("item_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_org_created_idx" ON "transactions" USING btree ("org_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_org_type_created_idx" ON "transactions" USING btree ("org_id","type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_holder_idx" ON "transactions" USING btree ("org_id","holder_id","item_id") WHERE custody_delta <> 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_actor_created_idx" ON "transactions" USING btree ("org_id","actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_org_email_unique" ON "users" USING btree ("org_id","email");