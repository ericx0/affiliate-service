import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase, supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * /api/affiliate/funnel — T4 (UTM funnel dashboard).
 *
 * One endpoint, four sections:
 *   1. Summary — total clicks / sign-ups / orders / commission
 *   2. By source (utm_source from the published_posts.utm_params JSONB)
 *   3. By platform (instagram / youtube / x / etc.)
 *   4. Daily series (last 30 days)
 *
 * Data sources:
 *   affiliate.referral_clicks        — every click on a KOL link
 *   affiliate.promoters              — promoter (KOL) identity
 *   public.orders + commissions      — paid orders attributed to the KOL
 *   affiliate.published_posts        — the utm_params payload we set at
 *                                       publish time (utm_source, etc.)
 *
 * We rely on the attribution join already provided by the existing
 * referral_clicks.converted_order_id column. UTM params join on
 * utm_source -> a synthetic "platform row" (eg. 'ig') when the KOL
 * attached that source at publish time.
 *
 * Query:
 *   ?from=ISO&to=ISO (defaults last 30 days)
 */

const DateRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const DEFAULT_DAYS = 30;

export async function getMyFunnel(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
  }
  const parsed = DateRangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }

  const now = new Date();
  const to = parsed.data.to ? new Date(parsed.data.to) : now;
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(to.getTime() - DEFAULT_DAYS * 86400 * 1000);

  // 1. clicks for this promoter in the window
  const { data: clicks, error: clicksErr } = await affiliateSupabase
    .from("referral_clicks")
    .select("id, referral_code, country, converted_order_id, converted_user_id, clicked_at")
    .eq("promoter_id", promoterId)
    .gte("clicked_at", from.toISOString())
    .lte("clicked_at", to.toISOString())
    .limit(5000);
  if (clicksErr) return internalError(res, "FUNNEL_CLICKS_FAILED", clicksErr);

  const totalClicks = (clicks ?? []).length;
  const convertedClicks = (clicks ?? []).filter((c) => c.converted_user_id).length;
  const orderIds = Array.from(
    new Set((clicks ?? []).map((c) => c.converted_order_id).filter((x): x is string => !!x)),
  );

  // 2. fetch orders + commission in batch
  let totalCommissionCents = 0;
  let orderCount = 0;
  if (orderIds.length > 0) {
    const { data: commissions } = await supabase
      .from("commissions")
      .select("order_id, amount_cents, status")
      .eq("promoter_id", promoterId)
      .in("order_id", orderIds);
    orderCount = new Set((commissions ?? []).map((c) => c.order_id)).size;
    totalCommissionCents = (commissions ?? [])
      .filter((c) => c.status !== "reversed")
      .reduce((acc, c) => acc + (c.amount_cents ?? 0), 0);
  }

  // 3. published_posts by utm_source/platform (T4 source-of-truth)
  const { data: published } = await affiliateSupabase
    .from("published_posts")
    .select("platform, utm_params, published_at, metrics")
    .eq("promoter_id", promoterId)
    .gte("published_at", from.toISOString())
    .lte("published_at", to.toISOString())
    .limit(2000);

  // Aggregate by utm_source -> derived click estimates from metrics + clicks
  // Clicks attribution is approximate: when utm_source is 'ig' we count
  // clicks that originated from sub_id 'ig' (KOL appended sub_id=ig at
  // publish time). Without that exact join, we report by-platform clicks
  // from referral_clicks.referral_code (KOL tags with platform as prefix).
  const byPlatform: Record<
    string,
    { clicks: number; signUps: number; orders: number; commissionCents: number }
  > = {};
  for (const c of clicks ?? []) {
    const p = platformFromCode(c.referral_code);
    if (!byPlatform[p]) byPlatform[p] = { clicks: 0, signUps: 0, orders: 0, commissionCents: 0 };
    byPlatform[p].clicks += 1;
    if (c.converted_user_id) byPlatform[p].signUps += 1;
    if (c.converted_order_id) byPlatform[p].orders += 1;
  }
  // Add commission per platform by re-querying commissions joined to clicks.
  if (orderIds.length > 0) {
    const { data: commissions } = await supabase
      .from("commissions")
      .select("order_id, amount_cents, status")
      .eq("promoter_id", promoterId)
      .in("order_id", orderIds);
    const orderPlatformMap = new Map<string, string>();
    for (const c of clicks ?? []) {
      if (c.converted_order_id) orderPlatformMap.set(c.converted_order_id, platformFromCode(c.referral_code));
    }
    for (const cm of commissions ?? []) {
      const p = orderPlatformMap.get(cm.order_id);
      if (p && byPlatform[p] && cm.status !== "reversed") {
        byPlatform[p].commissionCents += cm.amount_cents ?? 0;
      }
    }
  }

  // 4. daily series
  const dayMap = new Map<string, { date: string; clicks: number; signUps: number; orders: number }>();
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86400 * 1000)) {
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, { date: key, clicks: 0, signUps: 0, orders: 0 });
  }
  for (const c of clicks ?? []) {
    const key = new Date(c.clicked_at).toISOString().slice(0, 10);
    const row = dayMap.get(key);
    if (!row) continue;
    row.clicks += 1;
    if (c.converted_user_id) row.signUps += 1;
    if (c.converted_order_id) row.orders += 1;
  }
  const dailySeries = Array.from(dayMap.values());

  // 5. published_posts engagement (likes/shares/comments) summary
  const engagement = (published ?? []).reduce(
    (acc, p) => {
      const m = (p.metrics as Record<string, number>) ?? {};
      acc.likes += Number(m.likes ?? 0);
      acc.shares += Number(m.shares ?? 0);
      acc.comments += Number(m.comments ?? 0);
      acc.impressions += Number(m.impressions ?? 0);
      return acc;
    },
    { likes: 0, shares: 0, comments: 0, impressions: 0, posts: (published ?? []).length },
  );

  res.json({
    data: {
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: Math.ceil((to.getTime() - from.getTime()) / 86400_000),
      },
      summary: {
        clicks: totalClicks,
        signUps: convertedClicks,
        orders: orderCount,
        conversionRate: totalClicks > 0 ? convertedClicks / totalClicks : 0,
        commissionCents: totalCommissionCents,
      },
      byPlatform: Object.entries(byPlatform).map(([platform, v]) => ({
        platform,
        clicks: v.clicks,
        signUps: v.signUps,
        orders: v.orders,
        commissionCents: v.commissionCents,
        conversionRate: v.clicks > 0 ? v.signUps / v.clicks : 0,
      })),
      daily: dailySeries,
      engagement,
    },
  });
}

function platformFromCode(code: string | null): string {
  if (!code) return "other";
  const lower = code.toLowerCase();
  for (const p of ["ig", "tiktok", "fb", "youtube", "linkedin", "x"]) {
    if (lower.includes(p)) return p;
  }
  if (lower.startsWith("sub_")) return lower.slice(4, 12);
  return "other";
}
