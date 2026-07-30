-- ============================================================
-- Migration 014: Create affiliate.clients (KOL-managed customers)
-- ============================================================
-- KOLs introduce customers. Once a customer signs up via the KOL's
-- referral/promo code (main-site flow), the customer is auto-attached
-- to the KOL through affiliate.referral_clicks. This table lets the KOL
-- enrich that customer with: contact log, follow-up tasks (7-day SOP),
-- and patient-profile fields (age range, country, health concerns,
-- family history, budget).
--
-- The KOL never stores PHI directly — only the structured profile
-- fields they need to personalize outreach.
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning KOL.
  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id),

  -- Optional FK to the main-site user once the customer signs up via the
  -- KOL's link. NULL = "KOL helped pre-fill the form" (代注册) and we
  -- have not yet seen the customer's own auth user.
  user_id UUID,

  -- Customer display name (chosen by the KOL; the customer may rename
  -- themselves once they sign up).
  display_name TEXT NOT NULL,

  -- Optional phone / WeChat / Telegram — for the KOL's private outreach.
  contact_channel TEXT,
  contact_handle TEXT,

  -- Patient profile buckets (mirrors the case-library schema).
  age_range TEXT CHECK (age_range IN (
    '0-17', '18-29', '30-44', '45-59', '60-74', '75+', 'undisclosed'
  )),
  country_code TEXT,
  health_concerns TEXT[] DEFAULT '{}'::TEXT[],
  family_history TEXT,
  budget_bracket TEXT CHECK (budget_bracket IN (
    'under_10k', '10k_25k', '25k_50k', '50k_100k', 'over_100k', 'undisclosed'
  )),

  -- Lifecycle: 'lead' (KOL knows them) | 'engaged' (contacted) |
  -- 'qualified' (pre-review submitted) | 'converted' (paid order) |
  -- 'inactive' (no contact in 30d).
  status TEXT NOT NULL DEFAULT 'lead',

  -- Last contact / last activity timestamps for the 7-day SOP reminder.
  last_contact_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,

  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clients_promoter
  ON affiliate.clients(promoter_id, updated_at DESC);

CREATE INDEX idx_clients_status
  ON affiliate.clients(promoter_id, status);

CREATE INDEX idx_clients_followup
  ON affiliate.clients(promoter_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

ALTER TABLE affiliate.clients ENABLE ROW LEVEL SECURITY;

-- KOLs see only the rows they own. The portal reads via the
-- service-role key after kol-auth has confirmed identity, so the
-- RLS clause here matches on auth_user_id to avoid leaking across KOLs.
CREATE POLICY "clients_owner_read" ON affiliate.clients
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM affiliate.promoters p
      WHERE p.id = clients.promoter_id
        AND (
          p.email = auth.jwt() ->> 'email'
          OR p.id = auth.uid()  -- if promoter row carries auth.uid() as id
        )
    )
  );

CREATE POLICY "clients_owner_write" ON affiliate.clients
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM affiliate.promoters p
      WHERE p.id = clients.promoter_id
        AND p.email = auth.jwt() ->> 'email'
    )
  );

NOTIFY pgrst, 'reload schema';