DROP INDEX IF EXISTS "tx_item_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_org_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_entity_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_action_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_actor_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "tx_org_created_idx";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "seq" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "transactions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_seq_unique" ON "audit_events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_org_seq_idx" ON "audit_events" USING btree ("org_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tx_seq_unique" ON "transactions" USING btree ("seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_item_seq_idx" ON "transactions" USING btree ("item_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_org_seq_idx" ON "transactions" USING btree ("org_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_org_created_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_entity_idx" ON "audit_events" USING btree ("org_id","entity_type","entity_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_action_idx" ON "audit_events" USING btree ("org_id","action","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_actor_idx" ON "audit_events" USING btree ("org_id","actor_user_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_org_created_idx" ON "transactions" USING btree ("org_id","created_at");