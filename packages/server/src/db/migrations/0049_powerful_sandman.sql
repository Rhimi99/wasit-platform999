CREATE TABLE IF NOT EXISTS "ai_execution_switches" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"scope" varchar(10) NOT NULL,
	"target_key" varchar(64) NOT NULL,
	"stopped" boolean DEFAULT false NOT NULL,
	"reason" text,
	"actor_id" varchar(36),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_execution_switches_scope_chk" CHECK ("ai_execution_switches"."scope" in ('GLOBAL', 'AGENT')),
	CONSTRAINT "ai_execution_switches_target_chk" CHECK (("ai_execution_switches"."scope" = 'GLOBAL' and "ai_execution_switches"."target_key" = '*') or ("ai_execution_switches"."scope" = 'AGENT' and "ai_execution_switches"."target_key" <> '*'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_execution_switches_scope_target_idx" ON "ai_execution_switches" USING btree ("scope","target_key");--> statement-breakpoint
INSERT INTO "ai_execution_switches" ("id", "scope", "target_key", "stopped", "version")
VALUES ('00000000-0000-0000-0000-000000000001', 'GLOBAL', '*', false, 1)
ON CONFLICT ("scope", "target_key") DO NOTHING;
