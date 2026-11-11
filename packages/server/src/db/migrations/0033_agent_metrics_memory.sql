CREATE TABLE IF NOT EXISTS "agent_memory" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_key" varchar(64) NOT NULL,
	"scope_owner" varchar(36) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_metrics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"agent_key" varchar(64) NOT NULL,
	"task_id" varchar(36),
	"task_type" varchar(64),
	"scope_owner" varchar(36) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_agent_idx" ON "agent_memory" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_owner_idx" ON "agent_memory" USING btree ("scope_owner");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memory_kind_idx" ON "agent_memory" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_metrics_agent_idx" ON "agent_metrics" USING btree ("agent_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_metrics_owner_idx" ON "agent_metrics" USING btree ("scope_owner");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_metrics_outcome_idx" ON "agent_metrics" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_metrics_created_idx" ON "agent_metrics" USING btree ("created_at");