DO $$
DECLARE
  dup_count integer;
  dup_keys text;
BEGIN
  SELECT count(*), string_agg(format('%s (%s rows)', "key", cnt), ', ' ORDER BY "key")
    INTO dup_count, dup_keys
  FROM (
    SELECT "key", count(*) AS cnt
    FROM "agent_registry"
    GROUP BY "key"
    HAVING count(*) > 1
  ) AS duplicates;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add UNIQUE index on agent_registry.key: % duplicated key(s) found: %. Resolve these duplicates manually (merge or delete) before applying this migration; no rows were changed.',
      dup_count, dup_keys;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "agent_registry_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_registry_key_idx" ON "agent_registry" USING btree ("key");
