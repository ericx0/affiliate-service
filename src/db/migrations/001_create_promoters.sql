-- ============================================================
-- Migration 001: Create affiliate.promoters table
-- ============================================================

CREATE SCHEMA IF NOT EXISTS affiliate;

CREATE TABLE IF NOT EXISTS affiliate.promoters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  country_code TEXT,

  brand_name TEXT,
  bio TEXT,
  avatar_url TEXT,

  primary_platform TEXT,
  primary_platform_url TEXT,
  audience_country_codes TEXT[],

  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  commission_type TEXT NOT NULL DEFAULT 'standard',
  override_reason TEXT,
  override_by UUID,
  override_at TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'active',
  suspended_reason TEXT,
  suspended_at TIMESTAMPTZ,

  stripe_account_id TEXT UNIQUE,
  stripe_onboarding_completed BOOLEAN DEFAULT false,

  tax_form_type TEXT,
  tax_form_submitted_at TIMESTAMPTZ,

  total_referrals INTEGER DEFAULT 0,
  total_commission_earned NUMERIC(12,2) DEFAULT 0,
  total_commission_paid NUMERIC(12,2) DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_promoters_status ON affiliate.promoters(status);
CREATE INDEX idx_promoters_email ON affiliate.promoters(email);

ALTER TABLE affiliate.promoters ENABLE ROW LEVEL SECURITY;

-- KOL can read own row
CREATE POLICY "promoters_self_read" ON affiliate.promoters
  FOR SELECT USING (email = auth.jwt() ->> 'email');

-- Public read (for landing page validation)
CREATE POLICY "promoters_public_read" ON affiliate.promoters
  FOR SELECT USING (true);

NOTIFY pgrst, 'reload schema';
