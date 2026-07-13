import { Request, Response } from "express";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * GET /me/stats — 5 stat cards for the dashboard overview.
 */
export async function getMyStats(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_stats", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json(data ?? { totalPaid: 0, totalPending: 0, totalApproved: 0, totalClicks: 0, activeCodes: 0 });
}

/**
 * GET /me/earnings — paginated list of commission earnings with timeline.
 */
export async function getMyEarnings(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_earnings", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [] });
}

/**
 * GET /me/codes — list of referral codes with computed click counts.
 */
export async function getMyCodes(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_codes", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [] });
}

/**
 * GET /me/payouts — Stripe transfer history grouped by stripe_transfer_id.
 */
export async function getMyPayouts(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_my_payouts", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [] });
}

/**
 * GET /me — promoter profile subset (name, email, country, platform).
 */
export async function getMe(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_get_me", {
    p_promoter_id: promoterId,
  });
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? null });
}
