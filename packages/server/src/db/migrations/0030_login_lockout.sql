-- Login lockout: temporary brute-force lock for the password step.
-- Strictly ADDITIVE — two columns on `users` with safe defaults; no existing
-- column, index or row is altered or dropped, so this is safe on a populated
-- database.
--
-- `failed_login_attempts` is the running streak of wrong-password attempts and
-- `locked_until` is when the temporary lock lapses (NULL = not locked). They are
-- deliberately separate from `is_locked`, which stays the permanent
-- administrative/legal lock: a temporary lock must be able to expire without
-- ever clearing a permanent one.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
