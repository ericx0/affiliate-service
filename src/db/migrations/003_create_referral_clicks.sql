-- ============================================================
-- Migration 003: Create affiliate.referral_clicks table
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.referral_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  referral_code TEXT NOT NULL,
  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id),

  visitor_session_id TEXT NOT NULL,
  ip_address INET,
  user_agent TEXT,
  country TEXT,

  clicked_at TIMESTAMPTZ DEFAULT NOW(),
  attribution_window_ends_at TIMESTAMPTZ,

  converted_user_id UUID,
  converted_order_id UUID,
  converted_at TIMESTAMPTZ
);

CREATE INDEX idx_clicks_code ON affiliate.referral_clicks(referral_code);
CREATE INDEX idx_clicks_session ON affiliate.referral_clicks(visitor_session_id);
CREATE INDEX idx_clicks_promoter ON affiliate.referral_clicks(promoter_id);
CREATE INDEX idx_clicks_window ON affiliate.referral_clicks(attribution_window_ends_at)
  WHERE converted_order_id IS NULL;

ALTER TABLE affiliate.referral_clicks ENABLE ROW LEVEL SECURITY;

-- KOL reads own (IP masked via view)
CREATE POLICY "clicks_promoter_read_own" ON affiliate.referral_clicks
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = referral_clicks.promoter_id
            AND p.email = auth.jwt() ->> 'email')
  );

NOTIFY pgrst, 'reload schema';
