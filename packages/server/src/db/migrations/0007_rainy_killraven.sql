CREATE TYPE "public"."revenue_line_category" AS ENUM('INFRASTRUCTURE', 'PAYMENT_PROVIDER', 'AI_MODEL', 'MARKETING', 'SUPPORT', 'LEGAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."revenue_line_type" AS ENUM('REVENUE', 'COST');--> statement-breakpoint
CREATE TYPE "public"."scenario_status" AS ENUM('PLANNING', 'SAVED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revenue_accounts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"line_type" "revenue_line_type" DEFAULT 'COST' NOT NULL,
	"category" "revenue_line_category" DEFAULT 'OTHER' NOT NULL,
	"name" varchar(200) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"reference_type" varchar(40),
	"reference_id" varchar(36),
	"description" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scenario_reports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"status" "scenario_status" DEFAULT 'PLANNING' NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"created_by_id" varchar(36) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revenue_accounts_ref_idx" ON "revenue_accounts" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revenue_accounts_occurred_idx" ON "revenue_accounts" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revenue_accounts_category_idx" ON "revenue_accounts" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scenario_reports_creator_idx" ON "scenario_reports" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scenario_reports_created_idx" ON "scenario_reports" USING btree ("created_at");--> statement-breakpoint
