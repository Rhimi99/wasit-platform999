-- M2.4 — Refund Allocation (data foundation).
--
-- A single refund can cover several sellers when it spans more than one seller
-- suborder. This migration adds the allocation table that records, per seller
-- suborder (and optionally per line), how much of a refund is attributed to it.
-- It is a data foundation only: no service reads or writes it yet, and it writes
-- NO ledger entry — it is not a money movement, a wallet or a balance.
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
   WHERE schemaname = 'public' AND indexname = 'refunds_identity_idx';
  IF v_def IS NOT NULL
     AND (v_def NOT ILIKE 'CREATE UNIQUE INDEX%' OR v_def NOT ILIKE '%(id, order_id)%') THEN
    RAISE EXCEPTION 'refunds_identity_idx exists with an unexpected definition: %', v_def;
  END IF;

  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'order_items_identity_idx';
  IF v_def IS NOT NULL
     AND (v_def NOT ILIKE 'CREATE UNIQUE INDEX%' OR v_def NOT ILIKE '%(id, order_id, seller_order_id)%') THEN
    RAISE EXCEPTION 'order_items_identity_idx exists with an unexpected definition: %', v_def;
  END IF;

  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'seller_orders_identity_currency_idx';
  IF v_def IS NOT NULL
     AND (v_def NOT ILIKE 'CREATE UNIQUE INDEX%'
          OR v_def NOT ILIKE '%(id, parent_order_id, currency_code)%') THEN
    RAISE EXCEPTION 'seller_orders_identity_currency_idx exists with an unexpected definition: %', v_def;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'refund_allocations') THEN
    IF EXISTS (
      SELECT 1 FROM (VALUES
        ('id'), ('refund_id'), ('parent_order_id'), ('seller_order_id'),
        ('order_item_id'), ('amount'), ('currency_code'), ('created_at')
      ) AS expected(col)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name = 'refund_allocations'
           AND c.column_name = expected.col
      )
    ) THEN
      RAISE EXCEPTION 'refund_allocations already exists but is missing expected columns';
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'refund_allocations_amount_positive';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%amount%> 0%' THEN
      RAISE EXCEPTION 'refund_allocations_amount_positive exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'refund_allocations_currency_len';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%length(currency_code) = 3%' THEN
      RAISE EXCEPTION 'refund_allocations_currency_len exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'refund_allocations_refund_fk';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%REFERENCES refunds(id, order_id)%' THEN
      RAISE EXCEPTION 'refund_allocations_refund_fk exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'refund_allocations_suborder_fk';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%REFERENCES seller_orders(id, parent_order_id, currency_code)%' THEN
      RAISE EXCEPTION 'refund_allocations_suborder_fk exists with an unexpected definition: %', v_def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conname = 'refund_allocations_item_fk';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%REFERENCES order_items(id, order_id, seller_order_id)%' THEN
      RAISE EXCEPTION 'refund_allocations_item_fk exists with an unexpected definition: %', v_def;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
-- The identity indexes are created BEFORE the foreign keys that cite them: a
-- composite FK requires a UNIQUE target, so the target index must already exist
-- when the constraint is added (the ordering fixed for 0039).
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_identity_idx" ON "refunds" USING btree ("id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_identity_idx" ON "order_items" USING btree ("id","order_id","seller_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seller_orders_identity_currency_idx" ON "seller_orders" USING btree ("id","parent_order_id","currency_code");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refund_allocations" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "refund_id" varchar(36) NOT NULL,
        "parent_order_id" varchar(36) NOT NULL,
        "seller_order_id" varchar(36) NOT NULL,
        "order_item_id" varchar(36),
        "amount" numeric(18, 4) NOT NULL,
        "currency_code" varchar(3) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "refund_allocations_amount_positive" CHECK ("refund_allocations"."amount" > 0),
        CONSTRAINT "refund_allocations_currency_len" CHECK (length("refund_allocations"."currency_code") = 3)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_refund_fk" FOREIGN KEY ("refund_id","parent_order_id") REFERENCES "public"."refunds"("id","order_id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_suborder_fk" FOREIGN KEY ("seller_order_id","parent_order_id","currency_code") REFERENCES "public"."seller_orders"("id","parent_order_id","currency_code") ON DELETE restrict ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_item_fk" FOREIGN KEY ("order_item_id","parent_order_id","seller_order_id") REFERENCES "public"."order_items"("id","order_id","seller_order_id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refund_allocations_refund_suborder_idx" ON "refund_allocations" USING btree ("refund_id","seller_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_allocations_refund_idx" ON "refund_allocations" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_allocations_suborder_idx" ON "refund_allocations" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_allocations_parent_order_idx" ON "refund_allocations" USING btree ("parent_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_allocations_item_idx" ON "refund_allocations" USING btree ("order_item_id");
