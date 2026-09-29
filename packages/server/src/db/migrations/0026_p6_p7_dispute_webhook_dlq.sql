CREATE TYPE "public"."payment_webhook_status" AS ENUM('RECEIVED', 'PROCESSED', 'FAILED', 'DEAD_LETTERED');--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "status" "payment_webhook_status" DEFAULT 'RECEIVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_webhook_events_status_idx" ON "payment_webhook_events" USING btree ("status");--> statement-breakpoint
-- Pre-existing rows were all "processed" by definition (the old code only ever
-- kept a claim after a successful apply and deleted it otherwise), so marking
-- them PROCESSED keeps replays of historical events idempotent instead of
-- letting the new retry path re-run their side-effect.
UPDATE "payment_webhook_events" SET "status" = 'PROCESSED' WHERE "processed_at" IS NOT NULL;--> statement-breakpoint
-- P6: give the global dispute policy an explicit financial-effect map for the
-- decisions whose outcome is unambiguous. Non-destructive: it merges into the
-- existing rules and only adds the field, so an Admin-customised map is never
-- overwritten. SPLIT is deliberately omitted: its ratio is a negotiated figure,
-- so until a policy states it the engine reports DECISION_REQUIRED, not a guess.
UPDATE "policies"
SET
  "rules" = "rules" || jsonb_build_object(
    'decisionEffects',
    COALESCE("rules"->'decisionEffects', '{}'::jsonb) || jsonb_build_object(
      'IN_FAVOR_OF_BUYER', '{"effect":"REFUND_BUYER"}'::jsonb,
      'IN_FAVOR_OF_SELLER', '{"effect":"NONE"}'::jsonb,
      'REJECTED', '{"effect":"NONE"}'::jsonb
    )
  ),
  "updated_at" = now()
WHERE "scope" = 'DISPUTE'
  AND "code" = 'DISPUTE_RESOLUTION'
  AND "country_id" IS NULL;