-- Dedupe indexes for agent_tasks.
--
-- The unique index is PARTIAL: it constrains only OPEN tasks (a non-null
-- dedupe_key whose status is not terminal). Two live tasks may not share the
-- same (requested_by, dedupe_key), but a new task may reuse a key once the prior
-- task reached a terminal state. The terminal set is exactly the one Master
-- writes today: 'succeeded', 'failed', 'rejected', 'approved'. ('approved' is
-- terminal — the approval path settles a task to 'approved' with completed_at
-- set, see modules/ai/agents.ts.) No other status is assumed.
--
-- The DO block below refuses to build the index if existing rows would violate
-- it, and names the offending keys. It never deletes or merges data.
--> statement-breakpoint
DO $$
DECLARE
  dup record;
  dup_count integer := 0;
BEGIN
  FOR dup IN
    SELECT requested_by, dedupe_key, count(*) AS n
    FROM agent_tasks
    WHERE dedupe_key IS NOT NULL
      AND status NOT IN ('succeeded', 'failed', 'rejected', 'approved')
    GROUP BY requested_by, dedupe_key
    HAVING count(*) > 1
  LOOP
    dup_count := dup_count + 1;
    RAISE WARNING 'agent_tasks dedupe conflict: requested_by=%, dedupe_key=%, open rows=%',
      dup.requested_by, dup.dedupe_key, dup.n;
  END LOOP;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot create agent_tasks_dedupe_open_uidx: % duplicate open (requested_by, dedupe_key) group(s) exist. Resolve them manually, then re-run this migration. No data was changed.',
      dup_count;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_tasks_dedupe_idx" ON "agent_tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_dedupe_open_uidx" ON "agent_tasks" USING btree ("requested_by","dedupe_key") WHERE "agent_tasks"."dedupe_key" is not null and "agent_tasks"."status" not in ('succeeded', 'failed', 'rejected', 'approved');
