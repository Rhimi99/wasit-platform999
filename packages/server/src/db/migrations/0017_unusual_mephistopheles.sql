CREATE TABLE IF NOT EXISTS "alert_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"rule" varchar(80) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"summary" varchar(300) NOT NULL,
	"details" jsonb,
	"notified_channel" varchar(40),
	"notified_result" varchar(20),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_events_rule_idx" ON "alert_events" USING btree ("rule");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_events_status_idx" ON "alert_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_events_created_idx" ON "alert_events" USING btree ("created_at");