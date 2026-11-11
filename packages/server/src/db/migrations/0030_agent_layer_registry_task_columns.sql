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
ALTER TABLE "agent_tasks" ADD COLUMN "scheduled_for" timestamp with time zone;