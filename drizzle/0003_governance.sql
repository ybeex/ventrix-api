CREATE TYPE "public"."announcement_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'announcement';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'cycle_count_due';--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"severity" "announcement_severity" DEFAULT 'info' NOT NULL,
	"audience_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"send_email" boolean DEFAULT false NOT NULL,
	"published_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"retracted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"org_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"roles" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_org_id_type_pk" PRIMARY KEY("org_id","type")
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "near_minimum_percent" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "supervisors_can_invite" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_org_idx" ON "announcements" USING btree ("org_id","created_at");