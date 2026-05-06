-- Guest.Manager — Multi-tenant migration
-- Run once against your Supabase project via the SQL editor or CLI.

-- ── BUSINESSES: add multi-tenant columns ─────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS businesses_user_id_unique ON businesses(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS businesses_user_id_idx ON businesses(user_id);

-- ── TRIGGER: auto-create empty business on user signup ───────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.businesses (user_id, name, onboarding_complete)
  VALUES (NEW.id, 'My Business', FALSE)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── CREDENTIALS TABLE ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_credentials (
  business_id                   UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_phone_number_id      TEXT UNIQUE,
  whatsapp_business_account_id  TEXT,
  whatsapp_access_token_encrypted TEXT,
  whatsapp_verify_token         TEXT,
  whatsapp_display_number       TEXT,
  instagram_page_id             TEXT UNIQUE,
  instagram_access_token_encrypted TEXT,
  instagram_username            TEXT,
  facebook_page_id              TEXT UNIQUE,
  facebook_access_token_encrypted TEXT,
  facebook_page_name            TEXT,
  twilio_account_sid            TEXT,
  twilio_auth_token_encrypted   TEXT,
  twilio_phone_number           TEXT UNIQUE,
  updated_at                    TIMESTAMPTZ DEFAULT NOW(),
  created_at                    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bc_wa_pnid ON business_credentials(whatsapp_phone_number_id);
CREATE INDEX IF NOT EXISTS bc_ig_page ON business_credentials(instagram_page_id);
CREATE INDEX IF NOT EXISTS bc_fb_page ON business_credentials(facebook_page_id);
CREATE INDEX IF NOT EXISTS bc_twilio  ON business_credentials(twilio_phone_number);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
ALTER TABLE businesses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE spaces               ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_credentials ENABLE ROW LEVEL SECURITY;

-- Drop existing policies before recreating (idempotent)
DROP POLICY IF EXISTS "owner_select_biz" ON businesses;
DROP POLICY IF EXISTS "owner_update_biz" ON businesses;
DROP POLICY IF EXISTS "owner_creds"      ON business_credentials;
DROP POLICY IF EXISTS "tenant_conv"      ON conversations;
DROP POLICY IF EXISTS "tenant_msg"       ON messages;
DROP POLICY IF EXISTS "tenant_spaces"    ON spaces;

CREATE POLICY "owner_select_biz" ON businesses FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "owner_update_biz" ON businesses FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "owner_creds" ON business_credentials FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
);
CREATE POLICY "tenant_conv" ON conversations FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
);
CREATE POLICY "tenant_msg" ON messages FOR ALL USING (
  conversation_id IN (
    SELECT id FROM conversations WHERE business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  )
);
CREATE POLICY "tenant_spaces" ON spaces FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
);
