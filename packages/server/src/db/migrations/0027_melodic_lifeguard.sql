CREATE TABLE IF NOT EXISTS "agent_schedules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_key" varchar(64) NOT NULL,
	"input" jsonb NOT NULL,
	"interval_minutes" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"lease_owner" varchar(64),
	"lease_expires_at" timestamp with time zone,
	"last_task_id" varchar(36),
	"created_by" varchar(36) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_type" varchar(16) DEFAULT 'USER' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_due_idx" ON "agent_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_agent_idx" ON "agent_schedules" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_creator_idx" ON "agent_schedules" USING btree ("created_by");