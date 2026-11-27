CREATE TYPE "public"."rfq_event_type" AS ENUM('CREATED', 'SENT', 'VIEWED', 'RECIPIENT_DECLINED', 'QUOTE_SUBMITTED', 'QUOTE_REVISED', 'QUOTE_WITHDRAWN', 'QUOTE_ACCEPTED', 'QUOTE_REJECTED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."rfq_quote_status" AS ENUM('SUBMITTED', 'SUPERSEDED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."rfq_recipient_status" AS ENUM('INVITED', 'VIEWED', 'QUOTED', 'DECLINED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."rfq_status" AS ENUM('DRAFT', 'OPEN', 'AWARDED', 'CANCELLED', 'EXPIRED', 'CLOSED');--> statement-breakpoint
ALTER TYPE "public"."policy_scope" ADD VALUE 'B2B';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"rfq_id" varchar(36) NOT NULL,
	"actor_user_id" varchar(36),
	"actor_type" varchar(16) DEFAULT 'USER' NOT NULL,
	"event_type" "rfq_event_type" NOT NULL,
	"payload" jsonb,
	"visible_to_buyer" boolean DEFAULT true NOT NULL,
	"visible_to_seller" boolean DEFAULT false NOT NULL,
	"seller_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"rfq_id" varchar(36) NOT NULL,
	"product_id" varchar(36),
	"free_text_name" varchar(200),
	"quantity" numeric(18, 4) NOT NULL,
	"unit" varchar(40),
	"target_price" numeric(18, 4),
	"specifications" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_quote_lines" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"quote_id" varchar(36) NOT NULL,
	"rfq_item_id" varchar(36) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"line_total" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_quotes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"rfq_id" varchar(36) NOT NULL,
	"recipient_id" varchar(36) NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"seller_user_id" varchar(36) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"quote_status" "rfq_quote_status" DEFAULT 'SUBMITTED' NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"items_total" numeric(18, 4) NOT NULL,
	"lead_time_days" integer,
	"payment_terms" varchar(200),
	"notes" text,
	"valid_until" timestamp with time zone NOT NULL,
	"supersedes_id" varchar(36),
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_recipients" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"rfq_id" varchar(36) NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"seller_user_id" varchar(36) NOT NULL,
	"recipient_status" "rfq_recipient_status" DEFAULT 'INVITED' NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewed_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"consent_verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfqs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"rfq_number" varchar(40) NOT NULL,
	"buyer_company_id" varchar(36) NOT NULL,
	"buyer_user_id" varchar(36) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"currency_code" varchar(3) NOT NULL,
	"status" "rfq_status" DEFAULT 'DRAFT' NOT NULL,
	"quote_validity_days" integer DEFAULT 14 NOT NULL,
	"max_rounds" integer DEFAULT 5 NOT NULL,
	"needed_by" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"disclosure_acknowledged_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"awarded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_events_rfq_idx" ON "rfq_events" USING btree ("rfq_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_events_seller_idx" ON "rfq_events" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_rfq_idx" ON "rfq_items" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_product_idx" ON "rfq_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_quote_lines_quote_item_idx" ON "rfq_quote_lines" USING btree ("quote_id","rfq_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_quote_lines_quote_idx" ON "rfq_quote_lines" USING btree ("quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_quotes_rfq_seller_revision_idx" ON "rfq_quotes" USING btree ("rfq_id","seller_id","revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_quotes_rfq_idx" ON "rfq_quotes" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_quotes_seller_idx" ON "rfq_quotes" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_quotes_status_idx" ON "rfq_quotes" USING btree ("quote_status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_recipients_rfq_seller_idx" ON "rfq_recipients" USING btree ("rfq_id","seller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_recipients_rfq_idx" ON "rfq_recipients" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_recipients_seller_user_idx" ON "rfq_recipients" USING btree ("seller_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfqs_number_idx" ON "rfqs" USING btree ("rfq_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_buyer_company_idx" ON "rfqs" USING btree ("buyer_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_buyer_user_idx" ON "rfqs" USING btree ("buyer_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_status_idx" ON "rfqs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_expires_idx" ON "rfqs" USING btree ("expires_at");