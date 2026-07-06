-- Run after migration to verify row counts match

SELECT 'promoters' AS table_name,
  (SELECT count(*) FROM public.promoters) AS source_count,
  (SELECT count(*) FROM affiliate.promoters) AS target_count,
  (SELECT count(*) FROM public.promoters) = (SELECT count(*) FROM affiliate.promoters) AS matched
UNION ALL
SELECT 'referral_codes',
  (SELECT count(*) FROM public.referral_codes),
  (SELECT count(*) FROM affiliate.referral_codes),
  (SELECT count(*) FROM public.referral_codes) = (SELECT count(*) FROM affiliate.referral_codes)
UNION ALL
SELECT 'commissions',
  (SELECT count(*) FROM public.commissions),
  (SELECT count(*) FROM affiliate.commissions),
  (SELECT count(*) FROM public.commissions) = (SELECT count(*) FROM affiliate.commissions)
UNION ALL
SELECT 'referral_clicks',
  (SELECT count(*) FROM public.referral_tracking),
  (SELECT count(*) FROM affiliate.referral_clicks),
  (SELECT count(*) FROM public.referral_tracking) = (SELECT count(*) FROM affiliate.referral_clicks);