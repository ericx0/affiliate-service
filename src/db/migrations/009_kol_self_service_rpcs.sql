-- ============================================================
-- Migration 009: KOL self-service RPCs (P2-5 P2-6 P2-7 P2-8)
-- Purpose: Back the affiliate-portal dashboard endpoints
--   /api/affiliate/me/{stats,earnings,codes,payouts,me}
--   /api/affiliate/auth/register
-- ============================================================
-- All functions are SECURITY DEFINER + GRANT EXECUTE TO service_role
-- ONLY. The Express service authenticates the KOL's Supabase JWT
-- server-side, then calls these via its service-role Supabase client.
-- Direct anon/authenticated access is blocked to prevent email
-- enumeration and to keep the SQL surface minimal.

-- ────────────────────────────────────────────────────────────
-- 1. affiliate_get_promoter_by_email
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_get_promoter_by_email(p_email TEXT)
RETURNS SETOF affiliate.promoters
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT * FROM affiliate.promoters WHERE email = p_email LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.affiliate_get_promoter_by_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_get_promoter_by_email(TEXT) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 2. affiliate_get_my_stats
--    Flat object: { totalPaid, totalPending, totalApproved,
--                    totalClicks, activeCodes }
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_get_my_stats(p_promoter_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT json_build_object(
    'totalPaid',       COALESCE(total_paid, 0),
    'totalPending',    COALESCE(total_pending, 0),
    'totalApproved',   COALESCE(total_approved, 0),
    'totalClicks',     COALESCE(total_clicks, 0),
    'activeCodes',     COALESCE(active_codes, 0)
  )
  FROM affiliate.v_promoter_stats
  WHERE id = p_promoter_id;
$$;

REVOKE ALL ON FUNCTION public.affiliate_get_my_stats(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_get_my_stats(UUID) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 3. affiliate_get_my_earnings
--    Returns Earning[] (status mapped + timeline array)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_get_my_earnings(p_promoter_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.date DESC), '[]'::json)
  FROM (
    SELECT
      c.id::text                                       AS id,
      to_char(c.created_at, 'YYYY-MM-DD')             AS date,
      c.commission_amount                      AS "amountCents",
      CASE
        WHEN c.status IN ('cooling_down','pending') THEN 'pending'
        WHEN c.status = 'approved'                  THEN 'approved'
        WHEN c.status = 'paid'                       THEN 'paid'
        ELSE 'reversed'
      END                                              AS status,
      c.order_id::text                                 AS "referredOrderId",
      (
        SELECT COALESCE(json_agg(json_build_object('label', step.label, 'at', step.at)), '[]'::json)
        FROM (
          VALUES
            ('Order paid',        c.order_paid_at::text),
            ('Service completed', c.service_completed_at::text),
            ('Cool-down ends',    c.cool_down_until::text),
            ('Approved',          c.approved_at::text),
            ('Paid out',          c.paid_at::text)
        ) AS step(label, at)
        WHERE step.at IS NOT NULL
      )                                                AS timeline
    FROM affiliate.commissions c
    WHERE c.promoter_id = p_promoter_id
  ) t;
$$;

REVOKE ALL ON FUNCTION public.affiliate_get_my_earnings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_get_my_earnings(UUID) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 4. affiliate_get_my_codes
--    Returns ReferralCode[] with computed `uses`
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_get_my_codes(p_promoter_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."createdAt" DESC), '[]'::json)
  FROM (
    SELECT
      rc.id::text                          AS id,
      rc.code                              AS code,
      COALESCE(click_counts.uses, 0)       AS uses,
      rc.is_active                         AS active,
      rc.created_at::text                  AS "createdAt"
    FROM affiliate.referral_codes rc
    LEFT JOIN (
      SELECT referral_code, COUNT(*) AS uses
      FROM affiliate.referral_clicks
      GROUP BY referral_code
    ) click_counts ON click_counts.referral_code = rc.code
    WHERE rc.promoter_id = p_promoter_id
  ) t;
$$;

REVOKE ALL ON FUNCTION public.affiliate_get_my_codes(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_get_my_codes(UUID) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 5. affiliate_get_my_payouts
--    Returns Payout[] grouped by stripe_transfer_id
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_get_my_payouts(p_promoter_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t."paidAt" DESC), '[]'::json)
  FROM (
    SELECT
      c.stripe_transfer_id                AS id,
      MAX(c.paid_at)::text                 AS "paidAt",
      SUM(c.commission_amount)    AS "amountCents",
      'stripe'                            AS method,
      c.stripe_transfer_id                AS "stripeTransferId",
      COUNT(*)::int                       AS "earningsCount"
    FROM affiliate.commissions c
    WHERE c.promoter_id = p_promoter_id
      AND c.status = 'paid'
      AND c.stripe_transfer_id IS NOT NULL
    GROUP BY c.stripe_transfer_id
  ) t;
$$;

REVOKE ALL ON FUNCTION public.affiliate_get_my_payouts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_get_my_payouts(UUID) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 6. affiliate_get_me  (profile subset)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_get_me(p_promoter_id UUID)
RETURNS JSON
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT json_build_object(
    'name',                 name,
    'email',                email,
    'countryCode',          country_code,
    'primaryPlatform',      primary_platform,
    'primaryPlatformUrl',   primary_platform_url
  )
  FROM affiliate.promoters
  WHERE id = p_promoter_id;
$$;

REVOKE ALL ON FUNCTION public.affiliate_get_me(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_get_me(UUID) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 7. affiliate_self_register_promoter
--    Atomically creates a promoter + auto-generated referral code.
--    Returns { promoter, code }.
--    Throws SQLSTATE 23505 on duplicate email (caller maps to 409).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.affiliate_self_register_promoter(
  p_auth_user_id     UUID,
  p_name             TEXT,
  p_email            TEXT,
  p_country          TEXT,
  p_platform         TEXT,
  p_platform_url     TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_promoter_id UUID;
  v_code        TEXT;
  v_attempts    INT := 0;
BEGIN
  -- Insert promoter (email has UNIQUE constraint, will throw 23505 on duplicate)
  INSERT INTO affiliate.promoters (
    name, email, country_code, primary_platform, primary_platform_url
  ) VALUES (
    p_name, p_email, p_country, p_platform, p_platform_url
  )
  RETURNING id INTO v_promoter_id;

  -- Generate a unique 8-char referral code (uppercase alphanumeric).
  -- Loop with bounded retries to handle the (extremely rare) collision.
  LOOP
    v_code := upper(substring(md5(random()::text) from 1 for 8));
    BEGIN
      INSERT INTO affiliate.referral_codes (promoter_id, code, is_active)
      VALUES (v_promoter_id, v_code, true);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempts := v_attempts + 1;
      IF v_attempts > 10 THEN
        RAISE EXCEPTION 'Could not generate unique referral code after 10 attempts';
      END IF;
    END;
  END LOOP;

  RETURN json_build_object(
    'promoter', json_build_object(
      'id',                  v_promoter_id,
      'authUserId',          p_auth_user_id,
      'name',                p_name,
      'email',               p_email,
      'countryCode',         p_country,
      'primaryPlatform',     p_platform,
      'primaryPlatformUrl',  p_platform_url
    ),
    'code', v_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.affiliate_self_register_promoter(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_self_register_promoter(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
