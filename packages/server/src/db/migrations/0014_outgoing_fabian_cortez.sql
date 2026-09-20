ALTER TABLE "payment_intents" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "subscription_id" varchar(36);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_subscription_idx" ON "payment_intents" USING btree ("subscription_id");