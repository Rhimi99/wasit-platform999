CREATE TYPE "public"."media_asset_kind" AS ENUM('MARKETING_VIDEO', 'IMAGE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."media_asset_status" AS ENUM('PENDING', 'READY', 'FAILED', 'DELETED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_assets" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" varchar(36) NOT NULL,
	"kind" "media_asset_kind" DEFAULT 'MARKETING_VIDEO' NOT NULL,
	"status" "media_asset_status" DEFAULT 'PENDING' NOT NULL,
	"title" varchar(250) NOT NULL,
	"product_id" varchar(36),
	"campaign_id" varchar(36),
	"storage_key" text,
	"mime_type" varchar(100) DEFAULT 'video/mp4' NOT NULL,
	"extension" varchar(10) DEFAULT 'mp4' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"duration_seconds" varchar(20),
	"width" varchar(10),
	"height" varchar(10),
	"provider" varchar(60) DEFAULT 'structural' NOT NULL,
	"language" varchar(5) DEFAULT 'en' NOT NULL,
	"generation_spec" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_owner_idx" ON "media_assets" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_product_idx" ON "media_assets" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_kind_idx" ON "media_assets" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_created_idx" ON "media_assets" USING btree ("created_at");