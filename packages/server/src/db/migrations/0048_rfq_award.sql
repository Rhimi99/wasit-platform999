ALTER TABLE "rfqs" ADD COLUMN "awarded_quote_id" varchar(36);--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "order_id" varchar(36);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_quotes_one_accepted_idx" ON "rfq_quotes" USING btree ("rfq_id") WHERE quote_status = 'ACCEPTED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_order_idx" ON "rfqs" USING btree ("order_id");--> statement-breakpoint
-- B2B-01 phase 4: an accepted revision is the award record, so it is as final
-- as a rejected one. 0046 froze every other terminal status; ACCEPTED was
-- declared but unreachable then, and is now reachable.
CREATE OR REPLACE FUNCTION rfq_quotes_terminal_status() RETURNS trigger AS $$
BEGIN
  IF OLD.quote_status IN ('SUPERSEDED', 'WITHDRAWN', 'REJECTED', 'EXPIRED', 'ACCEPTED')
     AND NEW.quote_status <> OLD.quote_status THEN
    RAISE EXCEPTION 'rfq_quotes status % is terminal', OLD.quote_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
