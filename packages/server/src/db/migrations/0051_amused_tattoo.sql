-- 0050 creates the type with UNBLOCK_IP in it; IF NOT EXISTS keeps this
-- migration safe for the databases where 0050 was applied before that.
ALTER TYPE "public"."security_action_type" ADD VALUE IF NOT EXISTS 'UNBLOCK_IP' BEFORE 'REVOKE_SESSION';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_read_grants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"admin_user_id" varchar(36) NOT NULL,
	"scopes" text[] NOT NULL,
	"reason" text NOT NULL,
	"granted_by_id" varchar(36) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_amended_by_id" varchar(36),
	"revoked_at" timestamp with time zone,
	"revoked_by_id" varchar(36),
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_read_grants_admin_idx" ON "security_read_grants" USING btree ("admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "security_read_grants_one_live_idx" ON "security_read_grants" USING btree ("admin_user_id") WHERE revoked_at IS NULL AND expired_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_read_grants_expiry_idx" ON "security_read_grants" USING btree ("expires_at");