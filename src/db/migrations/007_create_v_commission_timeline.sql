-- ============================================================
-- Migration 007: Create v_commission_timeline view
-- ============================================================

CREATE OR REPLACE VIEW affiliate.v_commission_timeline AS
SELECT
  c.id,
  c.order_id,
  c.promoter_id,
  p.name AS promoter_name,
  p.email AS promoter_email,

  c.commission_type,
  c.order_amount,
  c.commission_rate,
  c.commission_amount,
  c.currency,

  c.status,
  c.month_key,

  c.order_paid_at,
  c.service_completed_at,
  c.cool_down_until,
  c.approved_at,
  c.paid_at,
  c.refunded_at,
  c.refund_reason,

  c.stripe_transfer_id,

  o.order_no,
  o.user_info->>'email' AS customer_email

FROM affiliate.commissions c
JOIN affiliate.promoters p ON p.id = c.promoter_id
LEFT JOIN public.orders o ON o.id = c.order_id;

NOTIFY pgrst, 'reload schema';
