ALTER TABLE "agent_schedules" ADD COLUMN "task_type" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;