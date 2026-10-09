-- Migration: notification-log dedup status + send-window tracking.
-- Run in the Supabase SQL Editor (or psql) against the production DB.
-- Idempotent: safe to re-run.

ALTER TABLE notifications_log
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';

ALTER TABLE notifications_log
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE;

-- The scheduler's atomic claim (INSERT ... ON CONFLICT DO NOTHING) requires
-- this unique constraint to exist. CREATE TABLE IF NOT EXISTS above does not
-- retro-fit constraints on a table that was created by an older schema, so
-- enforce it explicitly here.
DO $$
BEGIN
  ALTER TABLE notifications_log
    ADD CONSTRAINT notifications_log_user_id_prayer_name_date_type_key
    UNIQUE (user_id, prayer_name, date, type);
EXCEPTION
  WHEN duplicate_table THEN NULL;   -- constraint (and its backing index) exists
  WHEN duplicate_object THEN NULL;  -- same, older PG wording
END
$$;

-- Any duplicate rows that pre-date the constraint would have failed the ALTER
-- above; clean-up (keep oldest row per key) if that happened:
-- DELETE FROM notifications_log a
-- USING notifications_log b
-- WHERE a.ctid < b.ctid
--   AND a.user_id = b.user_id AND a.prayer_name = b.prayer_name
--   AND a.date = b.date AND a.type = b.type;
