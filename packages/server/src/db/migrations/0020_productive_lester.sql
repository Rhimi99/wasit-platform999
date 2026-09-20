ALTER TABLE "orders" ADD COLUMN "buyer_commission" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "buyer_commission" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_policies" ADD COLUMN "seller_rate" numeric(9, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_policies" ADD COLUMN "buyer_rate" numeric(9, 6) DEFAULT '0' NOT NULL;