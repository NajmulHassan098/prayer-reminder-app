-- 0006: General user settings blob (Hijri calendar prefs, tasbeeh counter).
-- Shape (all optional, normalized by src/utils/settings.js parseSettings):
--   { "calendar": { "tradition": "both|sunni|shia", "dayAdjust": -1|0|1 },
--     "tasbeeh":  { "target": 33, "dhikr": "SubhanAllah", "customDhikr": "",
--                   "sound": true, "haptics": true, "lastCount": 124 } }
-- Idempotent; the app degrades gracefully (see db.js) before this is applied.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN user_profiles.settings IS 'Non-notification user settings: calendar tradition filter, moon-sighting day adjustment, tasbeeh counter state/prefs.';
