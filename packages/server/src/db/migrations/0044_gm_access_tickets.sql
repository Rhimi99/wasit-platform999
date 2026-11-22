CREATE TABLE IF NOT EXISTS "gm_access_recoveries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"ticket_id" varchar(36),
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"had_factor" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gm_access_tickets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" text NOT NULL,
	"reason" text NOT NULL,
	"issued_by" varchar(120) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gm_access_recoveries_user_idx" ON "gm_access_recoveries" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gm_access_tickets_token_hash_idx" ON "gm_access_tickets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gm_access_tickets_user_idx" ON "gm_access_tickets" USING btree ("user_id");