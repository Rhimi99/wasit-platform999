CREATE TABLE IF NOT EXISTS "country_policy_gaps" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"country_id" varchar(36) NOT NULL,
	"scope" "policy_scope" NOT NULL,
	"code" varchar(120) NOT NULL,
	"status" varchar(30) DEFAULT 'DECISION_REQUIRED' NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "country_policy_gaps_unique_idx" ON "country_policy_gaps" USING btree ("country_id","scope","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "country_policy_gaps_status_idx" ON "country_policy_gaps" USING btree ("status");