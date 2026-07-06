-- ============================================================
-- Migration 004: Create affiliate.commissions table
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id),
  order_id UUID NOT NULL,
  subscription_id UUID,

  commission_type TEXT NOT NULL,

  order_amount NUMERIC(12,2) NOT NULL,
  commission_rate NUMERIC(5,2) NOT NULL,
  commission_amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',

  status TEXT NOT NULL DEFAULT 'cooling_down',
  -- 'cooling_down' | 'pending' | 'approved' | 'paid' | 'refunded' | 'reversed'

  order_paid_at TIMESTAMPTZ,
  service_completed_at TIMESTAMPTZ,
  cool_down_until TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  refund_reason TEXT,

  stripe_transfer_id TEXT,
  stripe_payout_date TIMESTAMPTZ,

  month_key TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(order_id, commission_type)
);

CREATE INDEX idx_commissions_promoter ON affiliate.commissions(promoter_id);
CREATE INDEX idx_commissions_status ON affiliate.commissions(status);
CREATE INDEX idx_commissions_cooldown ON affiliate.commissions(cool_down_until)
  WHERE status = 'cooling_down';
CREATE INDEX idx_commissions_month ON affiliate.commissions(month_key) WHERE status = 'paid';

ALTER TABLE affiliate.commissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "commissions_promoter_read_own" ON affiliate.commissions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = commissions.promoter_id
            AND p.email = auth.jwt() ->> 'email')
  );

NOTIFY pgrst, 'reload schema';
