-- Shelves → Categories → Items (every item in a category, every category on a shelf).
-- HAND-EDITED from the generated migration so it is safe on databases that already contain data:
-- columns are added NULLABLE, existing rows are attached to a default shelf/category, and only then do the NOT NULLs apply.
ALTER TYPE "public"."reconciliation_scope" ADD VALUE 'shelf' BEFORE 'location';--> statement-breakpoint
CREATE TABLE "shelves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"cycle_count_days" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shelves" ADD CONSTRAINT "shelves_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shelves_org_idx" ON "shelves" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shelves_org_name_unique" ON "shelves" USING btree ("org_id",lower("name")) WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "shelves_org_code_unique" ON "shelves" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "shelves_org_updated_idx" ON "shelves" USING btree ("org_id","updated_at");--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "shelf_id" uuid;--> statement-breakpoint

-- ── Backfill: one "Main shelf" per organization (in its default location), all existing categories on it ──
INSERT INTO "shelves" ("org_id", "location_id", "name", "code")
SELECT o."id",
       (SELECT l."id" FROM "locations" l WHERE l."org_id" = o."id" ORDER BY l."is_default" DESC, l."created_at" LIMIT 1),
       'Main shelf', 'SHF-0001'
FROM "organizations" o
WHERE EXISTS (SELECT 1 FROM "locations" l WHERE l."org_id" = o."id");--> statement-breakpoint
INSERT INTO "item_counters" ("org_id", "prefix", "next_value") SELECT "org_id", 'SHF', 2 FROM "shelves" ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "categories" c SET "shelf_id" = s."id" FROM "shelves" s WHERE s."org_id" = c."org_id" AND c."shelf_id" IS NULL;--> statement-breakpoint
-- A "General" category for every organization that does not already have one; items that had no category go there.
INSERT INTO "categories" ("org_id", "name", "shelf_id")
SELECT s."org_id", 'General', s."id" FROM "shelves" s
WHERE NOT EXISTS (SELECT 1 FROM "categories" c WHERE c."org_id" = s."org_id" AND lower(c."name") = 'general' AND c."archived_at" IS NULL);--> statement-breakpoint
UPDATE "items" i SET "category_id" = c."id" FROM "categories" c
WHERE i."category_id" IS NULL AND c."org_id" = i."org_id" AND lower(c."name") = 'general' AND c."archived_at" IS NULL;--> statement-breakpoint
-- An item's location is derived from its shelf.
UPDATE "items" i SET "location_id" = s."location_id"
FROM "categories" c JOIN "shelves" s ON s."id" = c."shelf_id"
WHERE c."id" = i."category_id" AND i."location_id" <> s."location_id";--> statement-breakpoint

ALTER TABLE "categories" ALTER COLUMN "shelf_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_shelf_id_shelves_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."shelves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_shelf_idx" ON "categories" USING btree ("org_id","shelf_id");
