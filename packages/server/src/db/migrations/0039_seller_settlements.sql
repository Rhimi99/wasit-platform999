-- M2.3 — Seller Suborder Settlement.
--
-- Replay / drift guard. Every object below is created with `IF NOT EXISTS`, but
-- that only checks the NAME: if an object with the same name already exists with
-- a DIFFERENT definition, the statement would silently leave a wrong schema. This
-- block refuses to run in that case, so a collision fails loudly instead of
-- producing a table/index that looks right and is not.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'transactions_identity_idx';
  IF v_def IS NOT NULL
     AND (v_def NOT ILIKE 'CREATE UNIQUE INDEX%' OR v_def NOT ILIKE '%(id, order_id)%') THEN
    RAISE EXCEPTION 'transactions_identity_idx exists with an unexpected definition: %', v_def;
  END IF;

  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'transaction_ledger_identity_idx';
  IF v_def IS NOT NULL
     AND (v_def NOT ILIKE 'CREATE UNIQUE INDEX%'
          OR v_def NOT ILIKE '%(id, transaction_id, entry_type, status)%') THEN
    RAISE EXCEPTION 'transaction_ledger_identity_idx exists with an unexpected definition: %', v_def;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'seller_settlements') THEN
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id'), ('seller_order_id'), ('parent_order_id'), ('transaction_id'),
        ('seller_id'), ('seller_type'), ('amount'), ('currency_code'), ('status'),
        ('parent_settlement_entry_id'), ('parent_entry_type'), ('parent_entry_status'),
        ('created_at'), ('updated_at'), ('settled_at')
      ) AS expected(col)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name = 'seller_settlements'
           AND c.column_name = expected.col
      )
    ) THEN
      RAISE EXCEPTION 'seller_settlements already exists but is missing expected columns';
    END IF;

    -- Each expected constraint must, if present, keep its expected shape.
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'seller_settlements_status_settled';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%status%SETTLED%' THEN
      RAISE EXCEPTION 'seller_settlements_status_settled exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'seller_settlements_suborder_fk';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%REFERENCES seller_orders(id, parent_order_id, seller_id)%' THEN
      RAISE EXCEPTION 'seller_settlements_suborder_fk exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'seller_settlements_parent_entry_fk';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%REFERENCES transaction_ledger(id, transaction_id, entry_type, status)%' THEN
      RAISE EXCEPTION 'seller_settlements_parent_entry_fk exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'seller_settlements_transaction_order_fk';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%REFERENCES transactions(id, order_id)%' THEN
      RAISE EXCEPTION 'seller_settlements_transaction_order_fk exists with an unexpected definition: %', v_def;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transaction_ledger_identity_idx" ON "transaction_ledger" USING btree ("id","transaction_id","entry_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_identity_idx" ON "transactions" USING btree ("id","order_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seller_settlements" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"seller_order_id" varchar(36) NOT NULL,
	"parent_order_id" varchar(36) NOT NULL,
	"transaction_id" varchar(36) NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency_code" varchar(3) NOT NULL,
	"status" "settlement_status" DEFAULT 'SETTLED' NOT NULL,
	"parent_settlement_entry_id" varchar(36) NOT NULL,
	"parent_entry_type" "ledger_entry_type" DEFAULT 'SETTLEMENT' NOT NULL,
	"parent_entry_status" "settlement_status" DEFAULT 'SETTLED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_settlements_status_settled" CHECK ("seller_settlements"."status" = 'SETTLED'),
	CONSTRAINT "seller_settlements_settled_requires_at" CHECK ("seller_settlements"."status" <> 'SETTLED' or "seller_settlements"."settled_at" is not null),
	CONSTRAINT "seller_settlements_amount_positive" CHECK ("seller_settlements"."amount" > 0),
	CONSTRAINT "seller_settlements_currency_len" CHECK (length("seller_settlements"."currency_code") = 3),
	CONSTRAINT "seller_settlements_parent_is_settlement" CHECK ("seller_settlements"."parent_entry_type" = 'SETTLEMENT'),
	CONSTRAINT "seller_settlements_parent_is_settled" CHECK ("seller_settlements"."parent_entry_status" = 'SETTLED')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_suborder_fk" FOREIGN KEY ("seller_order_id","parent_order_id","seller_id") REFERENCES "public"."seller_orders"("id","parent_order_id","seller_id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_parent_entry_fk" FOREIGN KEY ("parent_settlement_entry_id","transaction_id","parent_entry_type","parent_entry_status") REFERENCES "public"."transaction_ledger"("id","transaction_id","entry_type","status") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seller_settlements" ADD CONSTRAINT "seller_settlements_transaction_order_fk" FOREIGN KEY ("transaction_id","parent_order_id") REFERENCES "public"."transactions"("id","order_id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seller_settlements_suborder_idx" ON "seller_settlements" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_settlements_parent_order_idx" ON "seller_settlements" USING btree ("parent_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_settlements_transaction_idx" ON "seller_settlements" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_settlements_status_idx" ON "seller_settlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_settlements_parent_entry_idx" ON "seller_settlements" USING btree ("parent_settlement_entry_id");--> statement-breakpoint
