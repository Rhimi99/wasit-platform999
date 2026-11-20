CREATE TABLE IF NOT EXISTS "seller_orders" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"parent_order_id" varchar(36) NOT NULL,
	"order_number" varchar(40) NOT NULL,
	"seller_order_number" varchar(60) NOT NULL,
	"seller_id" varchar(36) NOT NULL,
	"seller_type" "seller_type" NOT NULL,
	"currency_code" varchar(3) DEFAULT 'TND' NOT NULL,
	"items_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"commission" numeric(18, 4) DEFAULT '0' NOT NULL,
	"buyer_commission" numeric(18, 4) DEFAULT '0' NOT NULL,
	"seller_commission" numeric(18, 4) DEFAULT '0' NOT NULL,
	"seller_payable" numeric(18, 4) DEFAULT '0' NOT NULL,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"settlement_status" "settlement_status" DEFAULT 'PENDING' NOT NULL,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "seller_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "seller_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "seller_order_id" varchar(36);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "seller_id" varchar(36);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seller_orders_parent_seller_idx" ON "seller_orders" USING btree ("parent_order_id","seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seller_orders_identity_idx" ON "seller_orders" USING btree ("id","parent_order_id","seller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_orders_parent_idx" ON "seller_orders" USING btree ("parent_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_orders_seller_idx" ON "seller_orders" USING btree ("seller_id","seller_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_orders_seller_created_idx" ON "seller_orders" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seller_orders_status_idx" ON "seller_orders" USING btree ("status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_suborder_fk" FOREIGN KEY ("seller_order_id","order_id","seller_id") REFERENCES "public"."seller_orders"("id","parent_order_id","seller_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_seller_order_idx" ON "order_items" USING btree ("seller_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_seller_idx" ON "order_items" USING btree ("seller_id");