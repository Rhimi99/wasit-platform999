CREATE TYPE "public"."tax_rule_status" AS ENUM('DECISION_REQUIRED', 'CONFIGURED', 'PROVIDER_MANAGED');--> statement-breakpoint
ALTER TYPE "public"."policy_scope" ADD VALUE 'TAX';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_tax_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"country_id" varchar(36),
	"region_code" varchar(50),
	"tax_type" varchar(50),
	"status" "tax_rule_status" NOT NULL,
	"rate" varchar(20),
	"amount" varchar(20),
	"currency_code" varchar(3),
	"jurisdiction_id" varchar(36),
	"policy_gap_id" varchar(36),
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tax_jurisdictions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"country_id" varchar(36) NOT NULL,
	"region_code" varchar(50),
	"tax_type" varchar(50) NOT NULL,
	"status" "tax_rule_status" DEFAULT 'DECISION_REQUIRED' NOT NULL,
	"rate" varchar(20),
	"price_includes_tax" boolean DEFAULT false NOT NULL,
	"applies_to" varchar(20) DEFAULT 'BUYER' NOT NULL,
	"provider_ref" varchar(200),
	"notes" text,
	"metadata" jsonb,
	"effective_from" timestamp with time zone,
	"created_by_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_tax_decisions_order_idx" ON "order_tax_decisions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_tax_decisions_status_idx" ON "order_tax_decisions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_jurisdictions_scope_idx" ON "tax_jurisdictions" USING btree ("country_id","region_code","tax_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_jurisdictions_country_idx" ON "tax_jurisdictions" USING btree ("country_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_jurisdictions_status_idx" ON "tax_jurisdictions" USING btree ("status");