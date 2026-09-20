ALTER TABLE "messages" ADD COLUMN "status" varchar(20) DEFAULT 'SENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "read_at" timestamp with time zone;