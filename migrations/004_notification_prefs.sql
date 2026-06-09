-- ── BUSINESSES: add notification preferences column ───────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{}'::jsonb;
