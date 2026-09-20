ALTER TABLE "dispute_appeals" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_appeals_status_idx" ON "dispute_appeals" USING btree ("status");