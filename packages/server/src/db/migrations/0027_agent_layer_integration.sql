-- Agent Layer integration: extend the existing agent registry/tasks and add
-- periodic schedules. Strictly ADDITIVE — no column, table or row is dropped,
-- so it is safe to run on a populated database.
ALTER TABLE "agent_registry" ADD COLUMN "name_ar" varchar(200);--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "mission" text;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "category" varchar(40) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "approval_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "task_types" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "status" varchar(20) DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_registry" ADD COLUMN "is_copilot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "task_type" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "approval_action" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "dedupe_key" varchar(200);--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "correlation_id" varchar(36);--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "triggered_by" varchar(64) DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "priority" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_dedupe_idx" ON "agent_tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_schedules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_key" varchar(64) NOT NULL,
	"task_type" varchar(64) NOT NULL,
	"interval_seconds" integer DEFAULT 86400 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_task_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_agent_idx" ON "agent_schedules" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_schedules_enabled_idx" ON "agent_schedules" USING btree ("enabled");
