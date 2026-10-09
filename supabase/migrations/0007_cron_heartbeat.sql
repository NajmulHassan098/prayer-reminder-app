-- 0007: Cron heartbeat — a single-row "the scheduler is alive" record.
--
-- WHY: reminders silently stopped working online because the in-process
-- node-cron tick inside src/server.js never fires on a short-lived serverless
-- invocation. The fix moves the trigger to an external HTTP call (GitHub
-- Actions or Vercel Cron hitting POST /api/cron/prayer-scheduler every 5 min).
-- Ops needs a way to PROVE that path is actually alive without reading logs,
-- so every successful tick upserts this row, and GET /api/health reads it.
--
-- SINGLE-ROW: id is CHECK'd to 1 so the table can never grow. The scheduler
-- uses `upsert` with `onConflict: 'id'`. RLS is enabled with no policies —
-- only the service-role key can read/write it, matching every other table.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  id                     INT PRIMARY KEY DEFAULT 1,
  last_started_at        TIMESTAMPTZ,
  last_finished_at       TIMESTAMPTZ,
  last_error             TEXT,
  users_seen             INT NOT NULL DEFAULT 0,
  emails_sent            INT NOT NULL DEFAULT 0,
  emails_skipped_stale   INT NOT NULL DEFAULT 0,
  dry_run                BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cron_heartbeat_singleton CHECK (id = 1)
);

ALTER TABLE cron_heartbeat ENABLE ROW LEVEL SECURITY;

-- Intentionally no policy rows: only the service-role key (which bypasses RLS)
-- can read or write this table. The GET /api/health endpoint reads it through
-- the same server-side db layer, so no anon access is needed.

COMMENT ON TABLE cron_heartbeat IS 'Single-row heartbeat written by every scheduler.tick() so /api/health can prove prod cron is actually firing.';
COMMENT ON COLUMN cron_heartbeat.last_error IS 'Populated only when the tick threw; a null value means the last tick completed cleanly.';
COMMENT ON COLUMN cron_heartbeat.dry_run IS 'TRUE when the tick ran with SCHEDULER_DRY_RUN=1 — no real emails were sent, the pipeline was exercised only.';
