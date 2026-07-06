-- ============================================================
-- Migration 002: Create affiliate.referral_codes table
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id) ON DELETE CASCADE,

  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',

  custom_landing_slug TEXT UNIQUE,
  custom_landing_enabled BOOLEAN DEFAULT false,

  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_referral_codes_promoter ON affiliate.referral_codes(promoter_id);
CREATE INDEX idx_referral_codes_active ON affiliate.referral_codes(code) WHERE is_active = true;

ALTER TABLE affiliate.referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "referral_codes_public_read" ON affiliate.referral_codes
  FOR SELECT USING (is_active = true);

CREATE POLICY "referral_codes_promoter_read_own" ON affiliate.referral_codes
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = referral_codes.promoter_id
            AND p.email = auth.jwt() ->> 'email')
  );

NOTIFY pgrst, 'reload schema';
