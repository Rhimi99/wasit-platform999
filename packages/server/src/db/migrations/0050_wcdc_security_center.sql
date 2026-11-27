-- WCDC-01 — security centre records (events, incidents, actions, blocks) and a
-- quarantine state for media assets. No business table is altered beyond the
-- additive enum value.
CREATE TYPE "security_severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "security_event_source" AS ENUM ('HTTP', 'AUTH', 'AI', 'MEDIA', 'ADMIN', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "security_incident_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'CONTAINED', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "security_action_type" AS ENUM ('RATE_LIMIT_TIGHTEN', 'BLOCK_IP', 'UNBLOCK_IP', 'REVOKE_SESSION', 'QUARANTINE_ASSET', 'ESCALATE', 'NOTIFY_GM', 'AI_KILL_SWITCH', 'FORBIDDEN_OPERATION');--> statement-breakpoint
CREATE TYPE "security_action_status" AS ENUM ('EXECUTED', 'REQUIRES_APPROVAL', 'REFUSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "security_block_kind" AS ENUM ('IP', 'SESSION');--> statement-breakpoint
CREATE TABLE "security_events" (
"id" varchar(36) PRIMARY KEY NOT NULL,
"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
"source" "security_event_source" DEFAULT 'HTTP' NOT NULL,
"category" varchar(32) NOT NULL,
"rule_id" varchar(60) NOT NULL,
"severity" "security_severity" NOT NULL,
"actor_id" varchar(36),
"actor_roles" jsonb,
"ip_address" varchar(64),
"user_agent" text,
"method" varchar(10),
"route" varchar(300),
"status_code" integer,
"tenant_id" varchar(36),
"session_hash" varchar(64),
"trace_id" varchar(64),
"fingerprint" varchar(32) NOT NULL,
"metadata" jsonb,
"incident_id" varchar(36),
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "security_events_occurred_idx" ON "security_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_rule_idx" ON "security_events" USING btree ("rule_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_actor_idx" ON "security_events" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_ip_idx" ON "security_events" USING btree ("ip_address","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_fingerprint_idx" ON "security_events" USING btree ("fingerprint","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_incident_idx" ON "security_events" USING btree ("incident_id");--> statement-breakpoint
CREATE TABLE "security_incidents" (
"id" varchar(36) PRIMARY KEY NOT NULL,
"rule_id" varchar(60) NOT NULL,
"category" varchar(32) NOT NULL,
"title" varchar(200) NOT NULL,
"severity" "security_severity" NOT NULL,
"status" "security_incident_status" DEFAULT 'OPEN' NOT NULL,
"risk_score" integer DEFAULT 0 NOT NULL,
"actor_id" varchar(36),
"ip_address" varchar(64),
"subject_key" varchar(80) NOT NULL,
"event_count" integer DEFAULT 1 NOT NULL,
"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
"summary" text,
"containment" jsonb,
"assigned_to_id" varchar(36),
"resolution_note" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "security_incidents_status_idx" ON "security_incidents" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "security_incidents_subject_idx" ON "security_incidents" USING btree ("rule_id","subject_key","status");--> statement-breakpoint
CREATE INDEX "security_incidents_last_seen_idx" ON "security_incidents" USING btree ("last_seen_at");--> statement-breakpoint
CREATE TABLE "security_actions" (
"id" varchar(36) PRIMARY KEY NOT NULL,
"incident_id" varchar(36),
"action_type" "security_action_type" NOT NULL,
"status" "security_action_status" NOT NULL,
"mode" varchar(8) DEFAULT 'MANUAL' NOT NULL,
"target" varchar(200),
"reason" text,
"requested_by_id" varchar(36),
"approved_by_id" varchar(36),
"approved_at" timestamp with time zone,
"result" jsonb,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "security_actions_incident_idx" ON "security_actions" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "security_actions_status_idx" ON "security_actions" USING btree ("status","created_at");--> statement-breakpoint
CREATE TABLE "security_blocks" (
"id" varchar(36) PRIMARY KEY NOT NULL,
"kind" "security_block_kind" NOT NULL,
"target" varchar(120) NOT NULL,
"reason" text,
"expires_at" timestamp with time zone NOT NULL,
"created_by_id" varchar(36),
"action_id" varchar(36),
"revoked_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "security_blocks_target_idx" ON "security_blocks" USING btree ("kind","target");--> statement-breakpoint
CREATE INDEX "security_blocks_expiry_idx" ON "security_blocks" USING btree ("expires_at");--> statement-breakpoint
ALTER TYPE "media_asset_status" ADD VALUE IF NOT EXISTS 'QUARANTINED';--> statement-breakpoint
ALTER TYPE "policy_scope" ADD VALUE IF NOT EXISTS 'SECURITY';
