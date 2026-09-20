ALTER TABLE "payment_intents" ADD COLUMN "method" varchar(20);--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "scheme" varchar(20);