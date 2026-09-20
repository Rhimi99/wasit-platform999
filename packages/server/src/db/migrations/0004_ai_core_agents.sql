CREATE TABLE IF NOT EXISTS "ai_models" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"context_window" integer DEFAULT 0 NOT NULL,
	"max_output_tokens" integer DEFAULT 0 NOT NULL,
	"input_per_1k" numeric(18, 10) DEFAULT '0' NOT NULL,
	"output_per_1k" numeric(18, 10) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_registry" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"key" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"capabilities" jsonb NOT NULL,
	"permissions_required" jsonb NOT NULL,
	"requires_human_approval" boolean DEFAULT false NOT NULL,
	"input_schema" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_tasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_key" varchar(64) NOT NULL,
	"requested_by" varchar(36) NOT NULL,
	"input" jsonb NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approved_by" varchar(36),
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"cost" varchar(40) DEFAULT '0' NOT NULL,
	"model" varchar(100) DEFAULT 'local-heuristic' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_models_key_idx" ON "ai_models" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_registry_key_idx" ON "agent_registry" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_agent_idx" ON "agent_tasks" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_user_idx" ON "agent_tasks" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_status_idx" ON "agent_tasks" USING btree ("status");