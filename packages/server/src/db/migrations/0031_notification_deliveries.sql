-- PR-09: per-channel delivery ledger for lifecycle notifications.
-- Strictly ADDITIVE — one new table; no existing table, column, index or row is
-- altered or dropped, so this is safe on a populated database.
--
-- One row per (event, entity, recipient, channel). The unique `dedupe_key`
-- enforces idempotency in the database: a repeated trigger (a webhook
-- redelivery, a retried order transition) inserts nothing, so a recipient is
-- never notified twice for the same event. `status` records the outcome
-- (SENT / FAILED / SKIPPED) and is written only after the send attempt, so the
-- row is the durable signal of what actually left the system.
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
