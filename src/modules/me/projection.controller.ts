import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * GET /api/affiliate/me/commission-projection?days=30
 *
 * Forecasts the KOL's 30-day commission based on the trailing N days
 * of approved + paid + cooling_down commissions. The simple model:
 *
 *     avg_daily_commission = sum(window) / days
 *     projection_30d       = avg_daily * 30
 *
 * Good enough for the dashboard's "what you'll earn this month if
 * nothing changes" estimate; the portal surfaces this as a confidence
 * band (not a guarantee).
 */
const QuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).default(30),
});

export async function getMyProjection(req: Request, res: Response) {
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

  // Pull all commissions in window (we'll bucket + sum in JS so the
  // portal gets a complete daily series regardless of empty days).
  const { data, error } = await affiliateSupabase
    .from("commissions")
    .select("commission_amount, currency, created_at, order_paid_at, status")
    .eq("promoter_id", promoterId)
    .gte("created_at", sinceISO);
  if (error) {
    internalError(res, "PROJECTION_QUERY_FAILED", error);
    return;
  }
  const rows = data ?? [];

  // Daily series — fill all days so the chart is contiguous.
  const dailySeries = buildDailySeries(days, rows);
  const totalCents = dailySeries.reduce((sum, d) => sum + d.commission_cents, 0);
  const daysWithData = dailySeries.filter((d) => d.commission_cents > 0).length || 1;
  const avgDailyCents = Math.round(totalCents / daysWithData);
  const projection30dCents = Math.round(avgDailyCents * 30);

  res.json({
    days,
    avg_daily_commission_cents: avgDailyCents,
    projection_30d_cents: projection30dCents,
    currency: pickCurrency(rows) ?? "USD",
    daily_series: dailySeries,
  });
}

interface DailyCommission {
  date: string;
  commission_cents: number;
}

function buildDailySeries(days: number, rows: Array<{ commission_amount: number | null; created_at: string | null; order_paid_at: string | null }>): DailyCommission[] {
  const buckets = new Map<string, DailyCommission>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { date: key, commission_cents: 0 });
  }
  for (const r of rows) {
    const stamp = r.order_paid_at ?? r.created_at;
    if (!stamp) continue;
    const k = stamp.slice(0, 10);
    const b = buckets.get(k);
    if (b) b.commission_cents += Math.round(Number(r.commission_amount ?? 0) * 100);
  }
  return Array.from(buckets.values());
}

function pickCurrency(rows: Array<{ currency: string | null }>): string | null {
  for (const r of rows) {
    if (r.currency) return r.currency;
  }
  return null;
}