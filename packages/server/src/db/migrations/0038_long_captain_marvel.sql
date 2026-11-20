DROP INDEX IF EXISTS "payouts_active_tx_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "payouts_completed_tx_idx";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "seller_order_id" varchar(36);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payouts" ADD CONSTRAINT "payouts_suborder_fk" FOREIGN KEY ("seller_order_id","order_id","seller_id") REFERENCES "public"."seller_orders"("id","parent_order_id","seller_id") ON DELETE restrict ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payouts_unit_live_idx" ON "payouts" USING btree ((CASE WHEN "seller_order_id" IS NOT NULL THEN 'S:' || "seller_order_id" ELSE 'T:' || "transaction_id" END)) WHERE "payouts"."status" in ('CREATED','PROCESSING','HELD','COMPLETED');