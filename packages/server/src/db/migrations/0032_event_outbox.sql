-- AI-08.0: transactional outbox for domain events routed to the AI layer.
-- Strictly ADDITIVE — one new table; no existing table, column, index or row is
-- altered or dropped, so this is safe on a populated database.
--
-- A row is written INSIDE the same transaction as the business change it
-- describes (e.g. order creation), so the event and the state that produced it
-- commit or roll back together: an event is never lost to a crash after the
-- business write, and is never announced for a transaction that never committed.
--
-- The unique `dedupe_key` (e.g. `order.placed:{orderId}`) enforces idempotency in
-- the database: a repeated enqueue inserts nothing. `status` tracks the delivery
-- state (PENDING / PROCESSING / PROCESSED / FAILED); `attempts` + `available_at`
-- drive retry with backoff; `locked_at` is the lease the watchdog uses to reclaim
-- a row abandoned by a worker that died while PROCESSING.
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
