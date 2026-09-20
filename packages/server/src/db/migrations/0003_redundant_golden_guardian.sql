CREATE TYPE "public"."dispute_event_type" AS ENUM('CREATED', 'EVIDENCE_ADDED', 'MESSAGE_ADDED', 'STATUS_CHANGED', 'ASSIGNED', 'DECIDED', 'REOPENED', 'APPEALED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispute_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispute_id" varchar(36) NOT NULL,
	"actor_id" varchar(36),
	"event_type" "dispute_event_type" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "assigned_to_id" varchar(36);--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_events_dispute_idx" ON "dispute_events" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_events_actor_idx" ON "dispute_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disputes_assigned_idx" ON "disputes" USING btree ("assigned_to_id");