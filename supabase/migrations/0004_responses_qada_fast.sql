-- 0004: Qaḍā tracker + Ramadan fast rows, both on the existing `responses`
-- table (reuses the (user, prayer_name, date) identity and the pending/mark
-- machinery). Idempotent; nullable/defaulted so code can ship before or after.

ALTER TABLE responses ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'salah';
ALTER TABLE responses ADD COLUMN IF NOT EXISTS made_up_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN responses.kind IS 'salah (default) | fast (Ramadan sahm; never auto-marked missed, excluded from prayer counts)';
COMMENT ON COLUMN responses.made_up_at IS 'Qaḍā: set when the user marked a missed prayer as made up. Private; never emailed or shown in group views.';
