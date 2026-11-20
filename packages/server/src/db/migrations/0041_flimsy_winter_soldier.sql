CREATE TABLE IF NOT EXISTS "payment_webhook_attempts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"webhook_event_id" varchar(36) NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"failure_class" varchar(32),
	"error_message" text,
	"retry_scheduled" boolean DEFAULT false NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "failure_class" varchar(32);--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "claim_token" varchar(64);--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "replay_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_webhook_attempts" ADD CONSTRAINT "payment_webhook_attempts_webhook_event_id_payment_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."payment_webhook_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_webhook_attempts_event_idx" ON "payment_webhook_attempts" USING btree ("webhook_event_id","attempt_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_webhook_events_retry_idx" ON "payment_webhook_events" USING btree ("status","next_attempt_at");