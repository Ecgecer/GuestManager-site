-- Guest.Manager — Migration 003: missing columns + plans table
-- Safe to run multiple times (IF NOT EXISTS / idempotent).
-- Run after 001_multi_tenant.sql and 002_usage_and_analytics.sql.

-- ── BUSINESSES: add runtime columns ──────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS type                    TEXT,
  ADD COLUMN IF NOT EXISTS hours                   TEXT,
  ADD COLUMN IF NOT EXISTS location                TEXT,
  ADD COLUMN IF NOT EXISTS phone                   TEXT,
  ADD COLUMN IF NOT EXISTS booking_url             TEXT,
  ADD COLUMN IF NOT EXISTS services                JSONB  DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS notes                   TEXT,
  ADD COLUMN IF NOT EXISTS source_url              TEXT,
  ADD COLUMN IF NOT EXISTS confidence              FLOAT  DEFAULT 1,
  ADD COLUMN IF NOT EXISTS plan_id                 TEXT   DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS owner_contact_id        TEXT,
  ADD COLUMN IF NOT EXISTS owner_channel           TEXT   DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS trial_ends_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_memory            TEXT,
  ADD COLUMN IF NOT EXISTS reply_memory_json       TEXT,
  ADD COLUMN IF NOT EXISTS reply_memory_count      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reply_memory_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ DEFAULT NOW();

-- ── PLANS TABLE ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  ai_cap        INTEGER,          -- NULL = unlimited
  overage_rate  NUMERIC(6,4) NOT NULL DEFAULT 0.03,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO plans (id, name, monthly_price, ai_cap, overage_rate) VALUES
  ('trial',   '14-Day Trial',  0,   250,  0.03),
  ('starter', 'Starter',       19,  250,  0.03),
  ('growth',  'Growth',        49,  1000, 0.03),
  ('agency',  'Agency',        149, NULL, 0.03)
ON CONFLICT (id) DO NOTHING;

-- ── CONVERSATIONS: add routing + metadata columns ─────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS space_id            UUID    REFERENCES spaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS routing_confidence  FLOAT,
  ADD COLUMN IF NOT EXISTS routing_reason      TEXT,
  ADD COLUMN IF NOT EXISTS escalate_reason     TEXT,
  ADD COLUMN IF NOT EXISTS escalate_count      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS message_count       INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_handling         BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_message_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS conv_space_id   ON conversations(space_id);
CREATE INDEX IF NOT EXISTS conv_business   ON conversations(business_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conv_contact    ON conversations(business_id, channel, contact_id);

-- ── MESSAGES: ensure role + confidence columns exist ─────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS confidence FLOAT,
  ADD COLUMN IF NOT EXISTS channel    TEXT;

CREATE INDEX IF NOT EXISTS msg_conv_id ON messages(conversation_id, created_at);

-- ── SPACES: ensure all columns exist ─────────────────────────
ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS keywords   JSONB   DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS color      TEXT    DEFAULT '#D4734A',
  ADD COLUMN IF NOT EXISTS active     BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- ── SPACE_MEMBERS: ensure table exists ───────────────────────
CREATE TABLE IF NOT EXISTS space_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  joined_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE space_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_space_members" ON space_members;
CREATE POLICY "tenant_space_members" ON space_members FOR ALL USING (
  space_id IN (
    SELECT id FROM spaces WHERE business_id IN (
      SELECT id FROM businesses WHERE user_id = auth.uid()
    )
  )
);

-- ── BUSINESSES: FK to plans ───────────────────────────────────
-- Only add if plans table was just created and FK doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'businesses_plan_id_fkey'
      AND table_name = 'businesses'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_plan_id_fkey
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
  END IF;
END $$;
