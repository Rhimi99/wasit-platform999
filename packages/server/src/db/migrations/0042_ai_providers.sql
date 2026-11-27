CREATE TABLE IF NOT EXISTS "ai_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"environment" varchar(20) NOT NULL,
	"provider_key" varchar(50) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"model" varchar(100) DEFAULT '' NOT NULL,
	"base_url" varchar(300),
	"key_source" varchar(20) DEFAULT 'NONE' NOT NULL,
	"key_env_var" varchar(100),
	"secret_ciphertext" text,
	"secret_fingerprint" varchar(32),
	"secret_updated_at" timestamp with time zone,
	"last_test_status" varchar(30) DEFAULT 'NEVER' NOT NULL,
	"last_test_mode" varchar(20),
	"last_tested_at" timestamp with time zone,
	"last_test_detail" jsonb,
	"updated_by" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_env_provider_uidx" ON "ai_providers" USING btree ("environment","provider_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_providers_env_idx" ON "ai_providers" USING btree ("environment");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_providers_env_default_uidx" ON "ai_providers" USING btree ("environment") WHERE "ai_providers"."is_default";