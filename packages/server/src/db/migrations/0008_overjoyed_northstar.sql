CREATE TYPE "public"."payment_intent_status" AS ENUM('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_intents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"external_ref" varchar(200),
	"status" "payment_intent_status" DEFAULT 'CREATED' NOT NULL,
	"failure_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_webhook_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider" varchar(100) NOT NULL,
	"event_id" varchar(200) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" varchar(10) DEFAULT 'false' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "idempotency_key" varchar(200);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intents_idem_idx" ON "payment_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_order_idx" ON "payment_intents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_external_idx" ON "payment_intents" USING btree ("external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_webhook_events_provider_event_idx" ON "payment_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_webhook_events_type_idx" ON "payment_webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_idem_idx" ON "refunds" USING btree ("idempotency_key");