-- 0008: notifications_log status-flow + heartbeat counters.
--
-- WHY: the reminder pipeline moved from a claim-then-DELETE model (a failed
-- SMTP send deleted its row, so a genuine failure left no audit and a delivery
-- that raced a crash could double-send) to an explicit status flow:
--   pending | sending -> sent | failed | skipped_stale
--                    | skipped_superseded | skipped_already_logged
-- Two supporting columns are needed:
--   claimed_at  when a tick last claimed the row, so an abandoned 'sending'
--               claim (the process died mid-send) can be reclaimed after 2 min
--               instead of freezing the event forever.
--   error       the provider error text captured on a 'failed' attempt.
-- cron_heartbeat gains the per-tick outcome counters surfaced by /api/health.
--
-- BACKWARD-COMPATIBLE: every statement is additive and idempotent (IF NOT
-- EXISTS / guarded). Old code paths keep working; the scheduler's db layer
-- degrades gracefully if these columns are not present yet, so it is safe to
-- deploy the app before or after this migration.

-- notifications_log ---------------------------------------------------------
ALTER TABLE notifications_log
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE notifications_log
  ADD COLUMN IF NOT EXISTS error TEXT;

COMMENT ON COLUMN notifications_log.claimed_at IS 'UTC instant a tick last claimed this row (status sending/pending). Used to detect an abandoned claim older than 2 minutes.';
COMMENT ON COLUMN notifications_log.error IS 'SMTP/provider error captured when status=failed; cleared on a later successful send.';
COMMENT ON COLUMN notifications_log.status IS 'pending|sending (in-flight) | sent | failed | skipped_stale | skipped_superseded | skipped_already_logged';

-- cron_heartbeat ------------------------------------------------------------
-- Only touch the table if 0007 has already created it; on a DB where 0007 has
-- not run yet this block is a no-op and the scheduler's heartbeat writer simply
-- degrades (see db.upsertCronHeartbeat strip-and-retry).
DO $$
BEGIN
  IF to_regclass('public.cron_heartbeat') IS NOT NULL THEN
    ALTER TABLE cron_heartbeat
      ADD COLUMN IF NOT EXISTS emails_superseded INT NOT NULL DEFAULT 0;
    ALTER TABLE cron_heartbeat
      ADD COLUMN IF NOT EXISTS emails_failed     INT NOT NULL DEFAULT 0;
    ALTER TABLE cron_heartbeat
      ADD COLUMN IF NOT EXISTS user_errors       INT NOT NULL DEFAULT 0;
  END IF;
END
$$;
