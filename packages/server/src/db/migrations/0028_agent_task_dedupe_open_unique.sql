-- Dedupe hardening: at most one *open* task per (owner, dedupe key).
-- Strictly ADDITIVE (a new partial unique index; nothing is dropped).
-- The WHERE clause excludes terminal statuses, so a completed task frees its key
-- for reuse (unchanged behaviour) and NULL keys are never constrained. Scoping
-- by requested_by keeps one owner's key from colliding with another owner's.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_dedupe_open_uidx"
  ON "agent_tasks" USING btree ("requested_by", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL
    AND "status" NOT IN ('succeeded', 'failed', 'rejected', 'blocked');
