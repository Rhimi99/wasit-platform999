CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"notification_id" varchar(36),
	"user_id" varchar(36) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"entity_type" varchar(60),
	"entity_id" varchar(36),
	"channel" varchar(30) NOT NULL,
	"status" varchar(20) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"vars" jsonb,
	"dedupe_key" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_deliveries_dedupe_idx" ON "notification_deliveries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_user_idx" ON "notification_deliveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_entity_idx" ON "notification_deliveries" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_status_idx" ON "notification_deliveries" USING btree ("status");