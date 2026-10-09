-- 0003: Persist the Hijri date and Imsak/Sunrise that Aladhan already returns
-- but the app was discarding. All nullable: code degrades gracefully via
-- isUndefinedColumnError until this runs (see supabase/migrations convention).
-- hijri_month_num is the machine-readable month (1..12) used by the scheduler
-- for Ayyam al-Biḍʿ (13/14/15 of any month) and Ramadan (month 9) gating.

ALTER TABLE prayer_times ADD COLUMN IF NOT EXISTS hijri_day TEXT;
ALTER TABLE prayer_times ADD COLUMN IF NOT EXISTS hijri_month_num INT;
ALTER TABLE prayer_times ADD COLUMN IF NOT EXISTS hijri_month TEXT;
ALTER TABLE prayer_times ADD COLUMN IF NOT EXISTS hijri_year TEXT;
ALTER TABLE prayer_times ADD COLUMN IF NOT EXISTS imsak TEXT;
ALTER TABLE prayer_times ADD COLUMN IF NOT EXISTS sunrise TEXT;

COMMENT ON COLUMN prayer_times.hijri_day IS 'Aladhan Hijri day-of-month (civil-day convention) for this Gregorian date';
COMMENT ON COLUMN prayer_times.hijri_month_num IS '1..12; 9 = Ramadan. Gates seasonal scheduler events.';
COMMENT ON COLUMN prayer_times.imsak IS 'From Aladhan timings; some methods omit it (then NULL)';
