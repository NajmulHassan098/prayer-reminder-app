-- 0005: User language preference for emails/UI. NULL = auto-detect from
-- country (COUNTRY_LOCALE map), final fallback English. Idempotent.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS locale TEXT;

COMMENT ON COLUMN user_profiles.locale IS 'en | ur | tr | ar | id. NULL = auto from country, else en.';
