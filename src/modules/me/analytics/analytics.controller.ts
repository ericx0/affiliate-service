import { Request, Response } from "express";
import { z } from "zod";
import { supabase, affiliateSupabase } from "../../../config.js";
import { internalError } from "../../../utils/controller-error.js";
import { logger } from "../../../utils/logger.js";

/**
 * GET /api/affiliate/me/analytics?days=7|30|90
 *
 * Dashboard analytics for the authenticated KOL. Aggregates:
 *   - clicks       : referral_clicks
 *   - signups      : profiles.referred_by matches the KOL's referral codes
 *   - orders       : commissions.order_paid_at not null in window
 *   - commission   : sum of commission_amount
 *   - trend[]      : daily buckets
 *   - by_product[] : top orders.checkup_package_id
 *   - by_country[] : top referral_clicks.country
 *   - by_language[]: derived from referral_clicks.country (best-effort
 *                    mapping; the schema doesn't carry a per-click
 *                    language column, so we surface country as a
 *                    language proxy — the portal renders this as
 *                    "language detected".)
 */
const QuerySchema = z.object({
  days: z.coerce.number().int().refine((n) => [7, 30, 90].includes(n), {
    message: "days must be 7, 30, or 90",
  }).default(30),
});

export async function getMyAnalytics(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }
  const { days } = parsed.data;
  const sinceISO = new Date(Date.now() - days * 86400 * 1000).toISOString();

  // 1. Clicks total + daily trend.
  const { data: clicks, error: clicksErr } = await affiliateSupabase
    .from("referral_clicks")
    .select("id, country, clicked_at")
    .eq("promoter_id", promoterId)
    .gte("clicked_at", sinceISO);
  if (clicksErr) {
    internalError(res, "ANALYTICS_QUERY_FAILED", clicksErr, { stage: "clicks" });
    return;
  }

  // 2. Signups — main-site profiles with referred_by matching one of
  // the KOL's active referral codes. The KOL's codes carry the prefix
  // needed for the join. We resolve the codes first then match.
  const { data: codes } = await affiliateSupabase
    .from("referral_codes")
    .select("code")
    .eq("promoter_id", promoterId);
  const codeList = (codes ?? []).map((c) => c.code);
  let signups: Array<{ id: string; referred_by: string | null; created_at: string | null }> = [];
  if (codeList.length > 0) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, referred_by, created_at")
      .in("referred_by", codeList)
      .gte("created_at", sinceISO);
    signups = (profs ?? []) as typeof signups;
  }

  // 3. Orders + commission — main-site orders promoted by this KOL.
  //    The orders.promoter_id column is the direct join.
  const { data: orders, error: ordersErr } = await supabase
    .from("orders")
    .select("id, checkup_package_id, checkup_package_name, total_amount, currency, paid_at, created_at")
    .eq("promoter_id", promoterId)
    .gte("created_at", sinceISO);
  if (ordersErr) {
    internalError(res, "ANALYTICS_QUERY_FAILED", ordersErr, { stage: "orders" });
    return;
  }

  const { data: commissions, error: commErr } = await affiliateSupabase
    .from("commissions")
    .select("id, commission_amount, currency, order_paid_at, created_at, order_id")
    .eq("promoter_id", promoterId)
    .gte("created_at", sinceISO);
  if (commErr) {
    internalError(res, "ANALYTICS_QUERY_FAILED", commErr, { stage: "commissions" });
    return;
  }

  // 4. Daily trend — build a complete date axis (so the portal can
  //    render an uninterrupted line chart even when a day has zero
  //    activity).
  const trend = buildDailyTrend(days, clicks ?? [], signups ?? [], orders ?? [], commissions ?? []);

  // 5. by_product — top N checkup packages by order count.
  const byProduct = aggregateByProduct(orders ?? []);

  // 6. by_country — top referral-click countries.
  const byCountry = aggregateByKey((clicks ?? []).map((c) => c.country), 5);

  // 7. by_language — best-effort: map countries to the primary
  //    language their residents likely speak. The portal renders this
  //    as a "language inferred from click geolocation" hint.
  const byLanguage = aggregateByKey(
    (clicks ?? [])
      .map((c) => countryToLanguage(c.country))
      .filter((l): l is string => Boolean(l)),
    5,
  );

  const totalCommissionCents = (commissions ?? []).reduce(
    (sum, c) => sum + Math.round(Number(c.commission_amount ?? 0) * 100),
    0,
  );

  res.json({
    days,
    clicks: (clicks ?? []).length,
    signups: signups.length,
    orders: (orders ?? []).length,
    commission_cents: totalCommissionCents,
    currency: pickCurrency(commissions ?? []) ?? "USD",
    trend,
    by_product: byProduct,
    by_country: byCountry,
    by_language: byLanguage,
  });
}

interface DailyBucket {
  date: string;
  clicks: number;
  signups: number;
  orders: number;
  commission_cents: number;
}

function buildDailyTrend(
  days: number,
  clicks: Array<{ clicked_at: string | null }>,
  signups: Array<{ created_at: string | null }>,
  orders: Array<{ paid_at: string | null; created_at: string | null }>,
  commissions: Array<{ commission_amount: number; order_paid_at: string | null; created_at: string | null }>,
): DailyBucket[] {
  // Date-key → metrics.
  const buckets = new Map<string, DailyBucket>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, clicks: 0, signups: 0, orders: 0, commission_cents: 0 });
  }

  for (const c of clicks) {
    if (!c.clicked_at) continue;
    const k = c.clicked_at.slice(0, 10);
    const b = buckets.get(k);
    if (b) b.clicks += 1;
  }
  for (const s of signups) {
    if (!s.created_at) continue;
    const k = s.created_at.slice(0, 10);
    const b = buckets.get(k);
    if (b) b.signups += 1;
  }
  for (const o of orders) {
    const stamp = o.paid_at ?? o.created_at;
    if (!stamp) continue;
    const k = stamp.slice(0, 10);
    const b = buckets.get(k);
    if (b) b.orders += 1;
  }
  for (const c of commissions) {
    const stamp = c.order_paid_at ?? c.created_at;
    if (!stamp) continue;
    const k = stamp.slice(0, 10);
    const b = buckets.get(k);
    if (b) b.commission_cents += Math.round(Number(c.commission_amount ?? 0) * 100);
  }

  return Array.from(buckets.values());
}

function aggregateByProduct(orders: Array<{ checkup_package_id: string | null; checkup_package_name: string | null }>): Array<{ id: string | null; name: string | null; count: number }> {
  const m = new Map<string, { id: string | null; name: string | null; count: number }>();
  for (const o of orders) {
    const key = o.checkup_package_id ?? "__unknown__";
    const cur = m.get(key);
    if (cur) cur.count += 1;
    else m.set(key, { id: o.checkup_package_id, name: o.checkup_package_name, count: 1 });
  }
  return Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, 5);
}

function aggregateByKey(values: Array<string | null>, limit: number): Array<{ key: string; count: number }> {
  const m = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function pickCurrency(commissions: Array<{ currency: string | null }>): string | null {
  for (const c of commissions) {
    if (c.currency) return c.currency;
  }
  return null;
}

/**
 * Country code → primary language spoken. Used by the dashboard's
 * "language" breakdown (which is derived from click geolocation).
 * Limited to the countries the KOL audience has been observed in.
 */
function countryToLanguage(country: string | null): string | null {
  if (!country) return null;
  const map: Record<string, string> = {
    CN: "zh-CN", HK: "zh-HK", TW: "zh-TW", SG: "zh-SG",
    US: "en-US", GB: "en-GB", CA: "en-CA", AU: "en-AU", IE: "en-IE",
    ES: "es-ES", MX: "es-MX", AR: "es-AR",
    RU: "ru-RU", KZ: "ru-KZ",
    AE: "ar-AE", SA: "ar-SA", EG: "ar-EG",
    DE: "de-DE", FR: "fr-FR", IT: "it-IT", PT: "pt-PT", BR: "pt-BR",
  };
  return map[country.toUpperCase()] ?? null;
}

void logger;