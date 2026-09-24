CREATE TYPE "public"."payout_status" AS ENUM('CREATED', 'PROCESSING', 'COMPLETED', 'FAILED', 'HELD');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_source" AS ENUM('PROVIDER', 'BANK');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('MATCHED', 'MISMATCH');--> statement-breakpoint
CREATE TYPE "public"."wasit_receipt_source" AS ENUM('BANK_STATEMENT', 'ACQUIRER', 'PROVIDER');--> statement-breakpoint
CREATE TYPE "public"."wasit_receipt_status" AS ENUM('PENDING', 'RECEIVED', 'REVERSED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payouts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"status" "payout_status" DEFAULT 'CREATED' NOT NULL,
	"payout_ref" varchar(200),
	"provider_ref" varchar(200),
	"failure_reason" text,
	"idempotency_key" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payouts_completed_requires_ref" CHECK ("payouts"."status" <> 'COMPLETED' or "payouts"."payout_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_decisions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"import_id" varchar(36) NOT NULL,
	"reference" varchar(200) NOT NULL,
	"status" "reconciliation_status" NOT NULL,
	"mismatches" jsonb NOT NULL,
	"detail" jsonb,
	"provider" varchar(100),
	"matched_transaction_id" varchar(36),
	"ledger_entry_id" varchar(36),
	"audit_log_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_imports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"source" "reconciliation_source" NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"import_key" varchar(200),
	"checksum" varchar(128) NOT NULL,
	"line_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconciliation_lines" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"import_id" varchar(36) NOT NULL,
	"reference" varchar(200) NOT NULL,
	"settlement_ref" varchar(200),
	"payout_ref" varchar(200),
	"gross_amount" numeric(18, 4),
	"provider_fee" numeric(18, 4),
	"net_amount" numeric(18, 4),
	"currency_code" varchar(3) NOT NULL,
	"settled" boolean,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wasit_receipts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"reference" varchar(200) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"source" "wasit_receipt_source" NOT NULL,
	"status" "wasit_receipt_status" DEFAULT 'PENDING' NOT NULL,
	"received_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_idem_idx" ON "payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_payout_ref_idx" ON "payouts" USING btree ("payout_ref") WHERE "payouts"."payout_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_provider_ref_idx" ON "payouts" USING btree ("provider","provider_ref") WHERE "payouts"."provider_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_active_tx_idx" ON "payouts" USING btree ("transaction_id") WHERE "payouts"."status" in ('CREATED','PROCESSING','HELD');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_completed_tx_idx" ON "payouts" USING btree ("transaction_id") WHERE "payouts"."status" = 'COMPLETED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payouts_order_idx" ON "payouts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payouts_seller_idx" ON "payouts" USING btree ("seller_id","seller_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payouts_status_idx" ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_decisions_import_ref_idx" ON "reconciliation_decisions" USING btree ("import_id","reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_decisions_status_idx" ON "reconciliation_decisions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_decisions_matched_tx_idx" ON "reconciliation_decisions" USING btree ("matched_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_imports_checksum_idx" ON "reconciliation_imports" USING btree ("source","checksum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_imports_created_idx" ON "reconciliation_imports" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_lines_import_ref_idx" ON "reconciliation_lines" USING btree ("import_id","reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_lines_import_idx" ON "reconciliation_lines" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconciliation_lines_ref_idx" ON "reconciliation_lines" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wasit_receipts_source_ref_idx" ON "wasit_receipts" USING btree ("source","reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wasit_receipts_order_idx" ON "wasit_receipts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wasit_receipts_tx_idx" ON "wasit_receipts" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wasit_receipts_status_idx" ON "wasit_receipts" USING btree ("status");