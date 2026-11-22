CREATE TABLE IF NOT EXISTS "ai_spend_alerts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"environment" varchar(30) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"target_key" varchar(100) DEFAULT '' NOT NULL,
	"period" varchar(20) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"level" varchar(20) NOT NULL,
	"spent" numeric(18, 10) NOT NULL,
	"limit_amount" numeric(18, 10),
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_spend_counters" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"environment" varchar(30) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"target_key" varchar(100) DEFAULT '' NOT NULL,
	"period" varchar(20) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"spent" numeric(18, 10) DEFAULT '0' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_spend_limits" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"environment" varchar(30) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"target_key" varchar(100) DEFAULT '' NOT NULL,
	"period" varchar(20) NOT NULL,
	"max_cost" numeric(18, 10),
	"max_requests" integer,
	"warn_ratio" numeric(5, 4) DEFAULT '0.8000' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'USD' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" varchar(36),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "provider_key" varchar(100);--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "vendor_model" varchar(160);--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "agent_key" varchar(100);--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "environment" varchar(30);--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "cost_source" varchar(20);--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "request_key" varchar(160);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_spend_alerts_unique" ON "ai_spend_alerts" USING btree ("environment","scope","target_key","period","period_start","level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_spend_alerts_created_idx" ON "ai_spend_alerts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_spend_counters_unique" ON "ai_spend_counters" USING btree ("environment","scope","target_key","period","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_spend_limits_scope_idx" ON "ai_spend_limits" USING btree ("environment","scope","period");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_spend_limits_unique_scope" ON "ai_spend_limits" USING btree ("environment","scope","target_key","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_provider_idx" ON "ai_requests" USING btree ("provider_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_agent_idx" ON "ai_requests" USING btree ("agent_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_requests_env_idx" ON "ai_requests" USING btree ("environment","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_requests_request_key_uq" ON "ai_requests" USING btree ("request_key");