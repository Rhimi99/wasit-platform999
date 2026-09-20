CREATE TYPE "public"."deletion_stage" AS ENUM('REQUESTED', 'DEACTIVATED', 'RETENTION', 'REVIEW', 'ELIGIBLE', 'ANONYMIZED', 'DELETED', 'REJECTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consent_events" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "user_id" varchar(36) NOT NULL,
        "consent_type" varchar(100) NOT NULL,
        "action" varchar(20) NOT NULL,
        "granted" boolean NOT NULL,
        "actor_id" varchar(36),
        "from_granted" boolean,
        "source" varchar(40) DEFAULT 'USER' NOT NULL,
        "metadata" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_export_requests" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "user_id" varchar(36) NOT NULL,
        "requested_by" varchar(36) NOT NULL,
        "format" varchar(10) DEFAULT 'json' NOT NULL,
        "status" varchar(20) DEFAULT 'COMPLETED' NOT NULL,
        "scope" jsonb,
        "completed_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_deletion_requests" (
        "id" varchar(36) PRIMARY KEY NOT NULL,
        "user_id" varchar(36) NOT NULL,
        "requested_by" varchar(36) NOT NULL,
        "reason" text,
        "stage" "deletion_stage" DEFAULT 'REQUESTED' NOT NULL,
        "retention_policy" jsonb,
        "retention_until" timestamp with time zone,
        "reviewed_by" varchar(36),
        "reviewed_at" timestamp with time zone,
        "completed_at" timestamp with time zone,
        "anonymized_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_user_idx" ON "consent_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_type_idx" ON "consent_events" USING btree ("consent_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_events_created_idx" ON "consent_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_export_requests_user_idx" ON "data_export_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_export_requests_created_idx" ON "data_export_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_deletion_requests_user_idx" ON "data_deletion_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_deletion_requests_stage_idx" ON "data_deletion_requests" USING btree ("stage");