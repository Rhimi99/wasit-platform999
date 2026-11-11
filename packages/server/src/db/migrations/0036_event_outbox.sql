CREATE TABLE IF NOT EXISTS "event_outbox" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"aggregate_type" varchar(60) NOT NULL,
	"aggregate_id" varchar(36) NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_outbox_dedupe_idx" ON "event_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_outbox_due_idx" ON "event_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_outbox_aggregate_idx" ON "event_outbox" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_outbox_created_idx" ON "event_outbox" USING btree ("created_at");