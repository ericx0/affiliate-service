-- ============================================================
-- Migration 006: Create v_promoter_stats view
-- ============================================================

CREATE OR REPLACE VIEW affiliate.v_promoter_stats AS
SELECT
  p.id,
  p.name,
  p.email,
  p.brand_name,
  p.country_code,
  p.primary_platform,
  p.commission_rate,
  p.commission_type,
  p.status,
  p.stripe_onboarding_completed,
  p.created_at,

  COUNT(DISTINCT rc.id) FILTER (WHERE rc.is_active) AS active_codes,
  COUNT(DISTINCT clk.id) AS total_clicks,
  COUNT(DISTINCT c.id) AS total_commissions,

  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'paid'), 0) AS total_paid,
  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'approved'), 0) AS total_approved,
  COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status IN ('cooling_down', 'pending')), 0) AS total_pending,

  MAX(c.created_at) AS last_commission_at
FROM affiliate.promoters p
LEFT JOIN affiliate.referral_codes rc ON rc.promoter_id = p.id
LEFT JOIN affiliate.referral_clicks clk ON clk.promoter_id = p.id
LEFT JOIN affiliate.commissions c ON c.promoter_id = p.id
GROUP BY p.id;

NOTIFY pgrst, 'reload schema';
