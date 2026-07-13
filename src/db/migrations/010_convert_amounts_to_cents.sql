-- ============================================================
-- Migration 010: Convert commission_amount and order_amount to cents
-- Date: 2026-07-13
--
-- Why: P2/F33 from the production audit. JS float math via Math.round(x*100)
-- loses precision for large amounts and has a small second-order rounding
-- error when summing first then rounding. Switching to integer cents
-- eliminates both.
--
-- Strategy:
--   1. Backfill existing data: multiply by 100, store as bigint.
--   2. Change column type to bigint.
--   3. Update RPCs to reflect new units.
--   4. Document the unit on the column itself.
--
-- IMPORTANT — deployment order:
--   1. Deploy application code first (reads cents, no *100 multiplication).
--   2. Apply this migration (data backfill + type change).
--   There is a small window (typically <30s) where the new code reads
--   dollars from the unchanged DB and treats them as cents, sending
--   100x-low values to Stripe. This is bounded and recoverable; reverse
--   is much worse (100x overcharge).
-- ============================================================

-- 1. Backfill (multiply by 100, cast to bigint). Idempotent: if already
-- in cents the column values will be huge and the operator should abort.
DO $$
DECLARE
  sample_row RECORD;
  suspicious_count bigint;
BEGIN
  -- Sanity check: if any commission_amount is > 1,000,000 it might already
  -- be in cents (e.g. $10,000 commission = 1,000,000 cents). Refuse to
  -- proceed in that case and require manual verification.
  SELECT COUNT(*) INTO suspicious_count
  FROM affiliate.commissions
  WHERE commission_amount > 1000000;
  IF suspicious_count > 0 THEN
    RAISE EXCEPTION 'Found % rows with commission_amount > 1,000,000 — these may already be in cents. Aborting to prevent double-conversion. Verify manually before re-running.', suspicious_count;
  END IF;
END $$;

-- 2. Convert column types in-place. Using USING clause to backfill data.
ALTER TABLE affiliate.commissions
  ALTER COLUMN commission_amount TYPE BIGINT USING (commission_amount * 100)::BIGINT,
  ALTER COLUMN order_amount      TYPE BIGINT USING (order_amount      * 100)::BIGINT;

-- 3. Document the unit on each column.
COMMENT ON COLUMN affiliate.commissions.commission_amount IS 'Commission amount in cents (BIGINT). Application code and RPCs use this unit directly — never multiply by 100.';
COMMENT ON COLUMN affiliate.commissions.order_amount      IS 'Order amount in cents (BIGINT). Application code uses this unit directly.';

-- 4. The views in 006 and 007 just SELECT these columns, so they
-- automatically return cents. No change needed, but flag here.
COMMENT ON VIEW affiliate.v_promoter_stats IS 'Returns total_paid/total_approved/total_pending in CENTS (was dollars before migration 010).';
COMMENT ON VIEW affiliate.v_commission_timeline IS 'Returns order_amount/commission_amount in CENTS (was dollars before migration 010).';

-- 5. Refresh schema cache for PostgREST.
NOTIFY pgrst, 'reload schema';
