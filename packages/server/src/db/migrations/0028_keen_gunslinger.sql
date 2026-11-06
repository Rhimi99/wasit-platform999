CREATE TYPE "public"."agent_run_status" AS ENUM('DRAFT', 'PLANNING', 'AWAITING_APPROVAL', 'DISPATCHING', 'RUNNING', 'PAUSED', 'AGGREGATING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."agent_run_step_status" AS ENUM('PENDING', 'BLOCKED', 'READY', 'AWAITING_APPROVAL', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYING', 'SKIPPED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_run_steps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"run_id" varchar(36) NOT NULL,
	"step_key" varchar(64) NOT NULL,
	"agent_key" varchar(64) NOT NULL,
	"status" "agent_run_step_status" DEFAULT 'PENDING' NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approved_by" varchar(36),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_steps_priority_valid" CHECK ("agent_run_steps"."priority" >= 0),
	CONSTRAINT "agent_run_steps_attempts_valid" CHECK ("agent_run_steps"."attempt_count" >= 0 and "agent_run_steps"."max_attempts" >= 1 and "agent_run_steps"."attempt_count" <= "agent_run_steps"."max_attempts"),
	CONSTRAINT "agent_run_steps_depends_on_array" CHECK (jsonb_typeof("agent_run_steps"."depends_on") = 'array')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"run_key" varchar(128) NOT NULL,
	"title" varchar(300) NOT NULL,
	"description" text,
	"status" "agent_run_status" DEFAULT 'DRAFT' NOT NULL,
	"requested_by" varchar(36) NOT NULL,
	"summary" jsonb,
	"error" jsonb,
	"metadata" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_steps_run_step_idx" ON "agent_run_steps" USING btree ("run_id","step_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_run_idx" ON "agent_run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_agent_idx" ON "agent_run_steps" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_status_idx" ON "agent_run_steps" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_key_idx" ON "agent_runs" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_requester_idx" ON "agent_runs" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_created_idx" ON "agent_runs" USING btree ("created_at");