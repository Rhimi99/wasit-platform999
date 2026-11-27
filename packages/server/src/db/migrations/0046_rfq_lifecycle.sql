ALTER TABLE "rfq_events" ADD COLUMN "quote_id" varchar(36);--> statement-breakpoint
ALTER TABLE "rfq_events" ADD COLUMN "quote_revision" integer;--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD COLUMN "decided_by_user_id" varchar(36);--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfq_recipients" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rfq_recipients" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "rfq_recipients" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_events_quote_idx" ON "rfq_events" USING btree ("quote_id");
--> statement-breakpoint
-- B2B-01 phase 2: the negotiation record is a fact, not a draft. These guards
-- are in the database because a service-level rule can be bypassed by the next
-- code path that forgets it; a trigger cannot.
CREATE OR REPLACE FUNCTION rfq_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rfq_events is append-only (attempted %)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_events_no_rewrite ON rfq_events;
--> statement-breakpoint
CREATE TRIGGER rfq_events_no_rewrite
  BEFORE UPDATE OR DELETE ON rfq_events
  FOR EACH ROW EXECUTE FUNCTION rfq_events_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rfq_quote_lines_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rfq_quote_lines is append-only (attempted %)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_quote_lines_no_rewrite ON rfq_quote_lines;
--> statement-breakpoint
CREATE TRIGGER rfq_quote_lines_no_rewrite
  BEFORE UPDATE OR DELETE ON rfq_quote_lines
  FOR EACH ROW EXECUTE FUNCTION rfq_quote_lines_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rfq_quotes_frozen_terms() RETURNS trigger AS $$
BEGIN
  IF NEW.rfq_id <> OLD.rfq_id
     OR NEW.seller_id <> OLD.seller_id
     OR NEW.seller_user_id <> OLD.seller_user_id
     OR NEW.revision <> OLD.revision
     OR NEW.currency_code <> OLD.currency_code
     OR NEW.items_total <> OLD.items_total
     OR NEW.valid_until <> OLD.valid_until
     OR NEW.submitted_at <> OLD.submitted_at
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
  THEN
    RAISE EXCEPTION 'rfq_quotes terms are immutable after submission' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_quotes_frozen_terms ON rfq_quotes;
--> statement-breakpoint
CREATE TRIGGER rfq_quotes_frozen_terms
  BEFORE UPDATE ON rfq_quotes
  FOR EACH ROW EXECUTE FUNCTION rfq_quotes_frozen_terms();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rfq_quotes_terminal_status() RETURNS trigger AS $$
BEGIN
  IF OLD.quote_status IN ('SUPERSEDED', 'WITHDRAWN', 'REJECTED', 'EXPIRED')
     AND NEW.quote_status <> OLD.quote_status THEN
    RAISE EXCEPTION 'rfq_quotes status % is terminal', OLD.quote_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_quotes_terminal_status ON rfq_quotes;
--> statement-breakpoint
CREATE TRIGGER rfq_quotes_terminal_status
  BEFORE UPDATE ON rfq_quotes
  FOR EACH ROW EXECUTE FUNCTION rfq_quotes_terminal_status();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rfq_quotes_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rfq_quotes rows cannot be deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS rfq_quotes_no_delete ON rfq_quotes;
--> statement-breakpoint
CREATE TRIGGER rfq_quotes_no_delete
  BEFORE DELETE ON rfq_quotes
  FOR EACH ROW EXECUTE FUNCTION rfq_quotes_no_delete();
