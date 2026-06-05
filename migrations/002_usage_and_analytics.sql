-- Guest.Manager — Usage tracking & analytics tables
-- Run after 001_multi_tenant.sql

-- ── MONTHLY USAGE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monthly_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,  -- "YYYY-MM"
  ai_replies    INTEGER NOT NULL DEFAULT 0,
  guest_msgs    INTEGER NOT NULL DEFAULT 0,
  overage_msgs  INTEGER NOT NULL DEFAULT 0,
  overage_cost  NUMERIC(10, 4)  NOT NULL DEFAULT 0,
  notified_80   BOOLEAN NOT NULL DEFAULT FALSE,
  notified_100  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, month)
);

CREATE INDEX IF NOT EXISTS monthly_usage_biz_month ON monthly_usage(business_id, month);

ALTER TABLE monthly_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_usage" ON monthly_usage;
CREATE POLICY "tenant_usage" ON monthly_usage FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
);

-- Service role can always write (used by backend webhook handlers)
DROP POLICY IF EXISTS "service_usage" ON monthly_usage;
CREATE POLICY "service_usage" ON monthly_usage FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── USAGE NOTIFICATIONS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month         TEXT NOT NULL,
  threshold     INTEGER NOT NULL,  -- 80 or 100
  channel       TEXT NOT NULL DEFAULT 'sms',
  contact_id    TEXT,
  message_text  TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_notif_biz ON usage_notifications(business_id, month);

ALTER TABLE usage_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_notif" ON usage_notifications;
CREATE POLICY "tenant_notif" ON usage_notifications FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
);

-- ── ANALYTICS EVENTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,  -- 'message_received', 'ai_reply', 'escalation', etc.
  channel       TEXT,
  contact_id    TEXT,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_biz_type ON analytics_events(business_id, event_type);
CREATE INDEX IF NOT EXISTS analytics_biz_date ON analytics_events(business_id, created_at DESC);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_analytics" ON analytics_events;
CREATE POLICY "tenant_analytics" ON analytics_events FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE user_id = auth.uid())
);

-- ── INCREMENT_USAGE RPC ───────────────────────────────────────
-- Atomically upserts and increments ai_replies for a business/month.
-- Returns the updated row.
CREATE OR REPLACE FUNCTION increment_usage(p_business_id UUID, p_month TEXT)
RETURNS SETOF monthly_usage
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO monthly_usage (business_id, month, ai_replies)
  VALUES (p_business_id, p_month, 1)
  ON CONFLICT (business_id, month)
  DO UPDATE SET
    ai_replies = monthly_usage.ai_replies + 1,
    updated_at = NOW();

  RETURN QUERY
    SELECT * FROM monthly_usage
    WHERE business_id = p_business_id AND month = p_month;
END;
$$;
