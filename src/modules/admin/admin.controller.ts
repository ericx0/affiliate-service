import { Request, Response } from "express";
import { z } from "zod";
import { pgQuery, pgQueryOne } from "../../db/pg-client.js";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { paySingleCommission, payCommissions } from "../payouts/payouts.service.js";
import { writeAuditLog } from "./audit.service.js";

const adminCtx = (req: Request) => ({
  adminId: (req as any).adminId || "00000000-0000-0000-0000-000000000000",
  adminEmail: (req as any).adminEmail || "unknown@linkchinamed.com",
});

// ============================================================
// PAYOUT endpoints (Phase 3) — unchanged, use Stripe API directly
// ============================================================

const ManualPayoutSchema = z.object({
  commissionId: z.string().uuid(),
  reason: z.string().min(1),
});

export async function manualPayout(req: Request, res: Response) {
  const { commissionId, reason } = ManualPayoutSchema.parse(req.body);
  const ctx = adminCtx(req);

  const { data: before } = await supabase
    .from("commissions")
    .select("status, commission_amount, paid_at")
    .eq("id", commissionId)
    .single();

  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Commission not found" } });
  }

  const result = await paySingleCommission(commissionId);

  if (!result.success) {
    return res.status(500).json({ error: { code: "PAYOUT_FAILED", message: result.error } });
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "manual_payout",
    targetType: "commission",
    targetId: commissionId,
    beforeState: before,
    afterState: { status: "paid", paid_at: new Date().toISOString() },
    reason,
  });

  logger.info({ commissionId, adminEmail: ctx.adminEmail, reason }, "manual payout executed");
  res.json({ success: true, transferId: result.transferId, totalAmount: result.totalAmount });
}

const BatchPayoutSchema = z.object({
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function triggerBatchPayout(req: Request, res: Response) {
  const { monthKey } = BatchPayoutSchema.parse(req.body);
  const ctx = adminCtx(req);

  const { data: approved, error } = await supabase
    .from("commissions")
    .select("id")
    .eq("status", "approved");

  if (error || !approved || approved.length === 0) {
    return res.json({ success: true, paid: 0, message: "No approved commissions" });
  }

  const results = await payCommissions(approved.map((c) => c.id));
  const successful = results.filter((r) => r.success);

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "batch_payout",
    targetType: "month",
    targetId: monthKey,
    afterState: { successful: successful.length, failed: results.length - successful.length },
    reason: req.body.reason || "Admin-triggered batch payout",
  });

  res.json({
    success: true,
    paid: successful.length,
    failed: results.length - successful.length,
  });
}

// ============================================================
// PROMOTER endpoints — Phase A1: refactored to use pg client
// (bypasses PostgREST schema cache for views/tables not exposed)
// ============================================================

const ListPromotersSchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  platform: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

interface PromoterStatRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  brand_name: string | null;
  country_code: string | null;
  primary_platform: string | null;
  commission_rate: number;
  commission_type: string;
  status: string;
  stripe_onboarding_completed: boolean;
  created_at: string;
  active_codes: string;
  total_clicks: string;
  total_commissions: string;
  total_paid: string;
  total_approved: string;
  total_pending: string;
  last_commission_at: string | null;
}

export async function listPromoters(req: Request, res: Response) {
  const filters = ListPromotersSchema.parse(req.query);

  const where: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (filters.status) {
    where.push(`p.status = $${p++}`);
    params.push(filters.status);
  }
  if (filters.platform) {
    where.push(`p.primary_platform = $${p++}`);
    params.push(filters.platform);
  }
  if (filters.search) {
    where.push(`(p.name ILIKE $${p} OR p.email ILIKE $${p} OR p.brand_name ILIKE $${p})`);
    params.push(`%${filters.search}%`);
    p++;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      p.id, p.name, p.email, p.brand_name, p.country_code, p.primary_platform,
      p.commission_rate, p.commission_type, p.status, p.stripe_onboarding_completed,
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
    ${whereSql}
    GROUP BY p.id
    ORDER BY COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'paid'), 0) DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  params.push(filters.limit, filters.offset);

  try {
    const rows = await pgQuery<PromoterStatRow>(sql, params);
    // Serialize numeric strings to numbers
    const data = rows.map((r) => ({
      ...r,
      active_codes: Number(r.active_codes),
      total_clicks: Number(r.total_clicks),
      total_commissions: Number(r.total_commissions),
      total_paid: Number(r.total_paid),
      total_approved: Number(r.total_approved),
      total_pending: Number(r.total_pending),
    }));
    res.json(data);
  } catch (e: any) {
    logger.error({ err: e, sql }, "listPromoters failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

interface PromoterRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  brand_name: string | null;
  country_code: string | null;
  primary_platform: string | null;
  commission_rate: number;
  commission_type: string;
  status: string;
  stripe_onboarding_completed: boolean;
  created_at: string;
}

interface ReferralCodeRow extends Record<string, unknown> {
  id: string;
  promoter_id: string;
  code: string;
  type: string;
  is_active: boolean;
  custom_landing_slug: string | null;
  created_at: string;
}

export async function getPromoter(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const promoter = await pgQueryOne<PromoterRow>(
      `SELECT id, name, email, brand_name, country_code, primary_platform,
              commission_rate, commission_type, status, stripe_onboarding_completed, created_at
       FROM affiliate.promoters WHERE id = $1`,
      [id]
    );
    if (!promoter) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
    }
    const codes = await pgQuery<ReferralCodeRow>(
      `SELECT id, promoter_id, code, type, is_active, custom_landing_slug, created_at
       FROM affiliate.referral_codes WHERE promoter_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    res.json({ ...promoter, referral_codes: codes });
  } catch (e: any) {
    logger.error({ err: e }, "getPromoter failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

const UpdatePromoterSchema = z.object({
  commission_rate: z.number().min(0).max(50).optional(),
  commission_type: z.enum(["standard", "override"]).optional(),
  override_reason: z.string().optional(),
  status: z.enum(["active", "suspended", "blacklisted"]).optional(),
});

export async function updatePromoter(req: Request, res: Response) {
  const { id } = req.params;
  const updates = UpdatePromoterSchema.parse(req.body);
  const ctx = adminCtx(req);

  const before = await pgQueryOne<any>(
    `SELECT commission_rate, commission_type, status, override_reason FROM affiliate.promoters WHERE id = $1`,
    [id]
  );
  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const [k, v] of Object.entries(updates)) {
    sets.push(`${k} = $${p++}`);
    params.push(v);
  }
  if (updates.commission_type === "override") {
    sets.push(`override_by = $${p++}`);
    params.push(ctx.adminId);
    sets.push(`override_at = NOW()`);
  }
  sets.push(`updated_at = NOW()`);
  params.push(id);

  const sql = `UPDATE affiliate.promoters SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`;

  try {
    const result = await pgQueryOne(sql, params);
    await writeAuditLog({
      actorId: ctx.adminId,
      actorEmail: ctx.adminEmail,
      action: "update_promoter",
      targetType: "promoter",
      targetId: id,
      beforeState: before,
      afterState: { ...before, ...updates },
      reason: updates.override_reason || "admin update",
    });
    res.json(result);
  } catch (e: any) {
    logger.error({ err: e }, "updatePromoter failed");
    res.status(500).json({ error: { code: "UPDATE_FAILED", message: e.message } });
  }
}

const SuspendSchema = z.object({ reason: z.string().min(1) });

async function changePromoterStatus(
  req: Request,
  res: Response,
  newStatus: "active" | "suspended",
  action: "suspend" | "activate"
) {
  const { id } = req.params;
  const { reason } = SuspendSchema.parse(req.body);
  const ctx = adminCtx(req);

  const before = await pgQueryOne<any>(
    `SELECT status FROM affiliate.promoters WHERE id = $1`,
    [id]
  );
  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
  }

  const setStatus =
    newStatus === "suspended"
      ? `status = 'suspended', suspended_reason = $2, suspended_at = NOW(), updated_at = NOW()`
      : `status = 'active', suspended_reason = NULL, suspended_at = NULL, updated_at = NOW()`;

  const sql = `UPDATE affiliate.promoters SET ${setStatus} WHERE id = $1 RETURNING *`;
  try {
    const result = await pgQueryOne(sql, [id, reason]);
    await writeAuditLog({
      actorId: ctx.adminId,
      actorEmail: ctx.adminEmail,
      action,
      targetType: "promoter",
      targetId: id,
      beforeState: before,
      afterState: { ...before, status: newStatus, reason },
      reason,
    });
    res.json(result);
  } catch (e: any) {
    logger.error({ err: e }, `${action} promoter failed`);
    res.status(500).json({ error: { code: "UPDATE_FAILED", message: e.message } });
  }
}

export async function suspendPromoter(req: Request, res: Response) {
  return changePromoterStatus(req, res, "suspended", "suspend");
}

export async function activatePromoter(req: Request, res: Response) {
  return changePromoterStatus(req, res, "active", "activate");
}

// ============================================================
// CODES endpoint (uses pg)
// ============================================================

const ListCodesSchema = z.object({
  promoter_id: z.string().uuid().optional(),
  is_active: z.coerce.boolean().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export async function listCodes(req: Request, res: Response) {
  const filters = ListCodesSchema.parse(req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (filters.promoter_id) {
    where.push(`rc.promoter_id = $${p++}`);
    params.push(filters.promoter_id);
  }
  if (filters.is_active !== undefined) {
    where.push(`rc.is_active = $${p++}`);
    params.push(filters.is_active);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT rc.*, p.name AS promoter_name, p.email AS promoter_email, p.brand_name AS promoter_brand
    FROM affiliate.referral_codes rc
    LEFT JOIN affiliate.promoters p ON p.id = rc.promoter_id
    ${whereSql}
    ORDER BY rc.created_at DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  params.push(filters.limit, filters.offset);
  try {
    const rows = await pgQuery(sql, params);
    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e }, "listCodes failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

// ============================================================
// COMMISSIONS endpoints (uses pg for v_commission_timeline-like join)
// ============================================================

const ListCommissionsSchema = z.object({
  promoter_id: z.string().uuid().optional(),
  status: z.string().optional(),
  month_key: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

interface CommissionTimelineRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  promoter_id: string;
  promoter_name: string | null;
  promoter_email: string | null;
  commission_type: string;
  order_amount: number;
  commission_rate: number;
  commission_amount: number;
  currency: string;
  status: string;
  month_key: string | null;
  order_paid_at: string | null;
  service_completed_at: string | null;
  cool_down_until: string | null;
  approved_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  refund_reason: string | null;
  stripe_transfer_id: string | null;
  order_no: string | null;
  customer_email: string | null;
  created_at: string;
}

export async function listCommissions(req: Request, res: Response) {
  const filters = ListCommissionsSchema.parse(req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (filters.promoter_id) {
    where.push(`c.promoter_id = $${p++}`);
    params.push(filters.promoter_id);
  }
  if (filters.status) {
    where.push(`c.status = $${p++}`);
    params.push(filters.status);
  }
  if (filters.month_key) {
    where.push(`to_char(c.paid_at, 'YYYY-MM') = $${p++}`);
    params.push(filters.month_key);
  }
  if (filters.from) {
    where.push(`c.created_at >= $${p++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`c.created_at <= $${p++}`);
    params.push(filters.to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      c.id, c.order_id, c.promoter_id, p.name AS promoter_name, p.email AS promoter_email,
      c.commission_type, c.order_amount, c.commission_rate, c.commission_amount, c.currency,
      c.status, to_char(c.paid_at, 'YYYY-MM') AS month_key,
      c.order_paid_at, c.service_completed_at, c.cool_down_until, c.approved_at, c.paid_at,
      c.refunded_at, c.refund_reason, c.stripe_transfer_id,
      o.order_no, o.user_info->>'email' AS customer_email,
      c.created_at
    FROM affiliate.commissions c
    LEFT JOIN affiliate.promoters p ON p.id = c.promoter_id
    LEFT JOIN public.orders o ON o.id = c.order_id
    ${whereSql}
    ORDER BY c.created_at DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  params.push(filters.limit, filters.offset);

  try {
    const rows = await pgQuery<CommissionTimelineRow>(sql, params);
    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e }, "listCommissions failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

const CommissionActionSchema = z.object({ reason: z.string().min(1) });

export async function approveCommission(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = CommissionActionSchema.parse(req.body);
  const ctx = adminCtx(req);

  const before = await pgQueryOne<any>(
    `SELECT status, commission_amount FROM affiliate.commissions WHERE id = $1`,
    [id]
  );
  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Commission not found" } });
  }
  if (before.status !== "cooling_down" && before.status !== "approved") {
    return res.status(400).json({
      error: { code: "INVALID_STATE", message: `Cannot approve commission in status: ${before.status}` },
    });
  }

  try {
    const result = await pgQueryOne(
      `UPDATE affiliate.commissions
       SET status = 'approved', approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    await writeAuditLog({
      actorId: ctx.adminId,
      actorEmail: ctx.adminEmail,
      action: "approve_commission",
      targetType: "commission",
      targetId: id,
      beforeState: before,
      afterState: result,
      reason,
    });
    res.json(result);
  } catch (e: any) {
    logger.error({ err: e }, "approveCommission failed");
    res.status(500).json({ error: { code: "UPDATE_FAILED", message: e.message } });
  }
}

export async function reverseCommission(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = CommissionActionSchema.parse(req.body);
  const ctx = adminCtx(req);

  const before = await pgQueryOne<any>(
    `SELECT status, commission_amount, stripe_transfer_id FROM affiliate.commissions WHERE id = $1`,
    [id]
  );
  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Commission not found" } });
  }
  if (before.status !== "paid") {
    return res.status(400).json({
      error: { code: "INVALID_STATE", message: `Can only reverse paid commission, current: ${before.status}` },
    });
  }
  if (!before.stripe_transfer_id) {
    return res.status(400).json({ error: { code: "NO_TRANSFER", message: "No Stripe transfer to reverse" } });
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
    await stripe.transfers.createReversal(before.stripe_transfer_id, {
      amount: Math.round(Number(before.commission_amount) * 100),
      metadata: { commissionId: id, reason, reversedBy: ctx.adminEmail },
    });
  } catch (stripeErr: any) {
    logger.error({ stripeErr, id }, "Stripe reversal failed");
    return res.status(502).json({
      error: { code: "STRIPE_FAILED", message: `Stripe reversal failed: ${stripeErr.message}` },
    });
  }

  try {
    const result = await pgQueryOne(
      `UPDATE affiliate.commissions
       SET status = 'reversed', refunded_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    await writeAuditLog({
      actorId: ctx.adminId,
      actorEmail: ctx.adminEmail,
      action: "reverse_commission",
      targetType: "commission",
      targetId: id,
      beforeState: before,
      afterState: result,
      reason,
    });
    res.json(result);
  } catch (e: any) {
    logger.error({ err: e }, "reverseCommission DB update failed");
    res.status(500).json({ error: { code: "UPDATE_FAILED", message: e.message } });
  }
}

// ============================================================
// REFUNDS endpoint (read-only, uses pg)
// ============================================================

export async function listRefunds(req: Request, res: Response) {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  try {
    const rows = await pgQuery<CommissionTimelineRow>(
      `SELECT
         c.id, c.order_id, c.promoter_id, p.name AS promoter_name, p.email AS promoter_email,
         c.commission_type, c.order_amount, c.commission_rate, c.commission_amount, c.currency,
         c.status, to_char(c.paid_at, 'YYYY-MM') AS month_key,
         c.order_paid_at, c.service_completed_at, c.cool_down_until, c.approved_at, c.paid_at,
         c.refunded_at, c.refund_reason, c.stripe_transfer_id,
         o.order_no, o.user_info->>'email' AS customer_email,
         c.created_at
       FROM affiliate.commissions c
       LEFT JOIN affiliate.promoters p ON p.id = c.promoter_id
       LEFT JOIN public.orders o ON o.id = c.order_id
       WHERE c.status = 'refunded'
       ORDER BY c.refunded_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e }, "listRefunds failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

// ============================================================
// PAYOUTS endpoint (read-only, uses pg)
// ============================================================

export async function listPayouts(req: Request, res: Response) {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const monthKey = req.query.month_key as string | undefined;
  const params: unknown[] = [];
  let where = `c.status = 'paid'`;
  if (monthKey) {
    where += ` AND to_char(c.paid_at, 'YYYY-MM') = $${params.length + 1}`;
    params.push(monthKey);
  }
  params.push(limit, offset);

  try {
    const rows = await pgQuery<CommissionTimelineRow>(
      `SELECT
         c.id, c.order_id, c.promoter_id, p.name AS promoter_name, p.email AS promoter_email,
         c.commission_type, c.order_amount, c.commission_rate, c.commission_amount, c.currency,
         c.status, to_char(c.paid_at, 'YYYY-MM') AS month_key,
         c.order_paid_at, c.service_completed_at, c.cool_down_until, c.approved_at, c.paid_at,
         c.refunded_at, c.refund_reason, c.stripe_transfer_id,
         o.order_no, o.user_info->>'email' AS customer_email,
         c.created_at
       FROM affiliate.commissions c
       LEFT JOIN affiliate.promoters p ON p.id = c.promoter_id
       LEFT JOIN public.orders o ON o.id = c.order_id
       WHERE ${where}
       ORDER BY c.paid_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e }, "listPayouts failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

// ============================================================
// AUDIT LOGS endpoint (uses pg)
// ============================================================

const ListAuditSchema = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  target_type: z.string().optional(),
  target_id: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().default(100),
  offset: z.coerce.number().default(0),
});

export async function listAuditLogs(req: Request, res: Response) {
  const filters = ListAuditSchema.parse(req.query);
  const where: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  if (filters.actor) {
    where.push(`actor_id = $${p++}`);
    params.push(filters.actor);
  }
  if (filters.action) {
    where.push(`action = $${p++}`);
    params.push(filters.action);
  }
  if (filters.target_type) {
    where.push(`target_type = $${p++}`);
    params.push(filters.target_type);
  }
  if (filters.target_id) {
    where.push(`target_id = $${p++}`);
    params.push(filters.target_id);
  }
  if (filters.from) {
    where.push(`created_at >= $${p++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`created_at <= $${p++}`);
    params.push(filters.to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(filters.limit, filters.offset);
  const sql = `
    SELECT id, actor_id, actor_email, action, target_type, target_id,
           before_state, after_state, reason, created_at
    FROM affiliate.audit_logs
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT $${p++} OFFSET $${p++}
  `;
  try {
    const rows = await pgQuery(sql, params);
    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e }, "listAuditLogs failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}

// ============================================================
// DASHBOARD endpoint (uses pg for KPI aggregation)
// ============================================================

export async function getDashboardStats(_req: Request, res: Response) {
  try {
    const thisMonth = await pgQueryOne<any>(`
      SELECT
        COALESCE(SUM(order_amount), 0)::numeric AS gmv,
        COUNT(*)::int AS order_count
      FROM affiliate.commissions
      WHERE created_at >= date_trunc('month', NOW())
    `);

    const paidCommissions = await pgQueryOne<any>(`
      SELECT
        COALESCE(SUM(commission_amount), 0)::numeric AS paid
      FROM affiliate.commissions
      WHERE status = 'paid'
        AND created_at >= date_trunc('month', NOW())
    `);

    const pendingCommissions = await pgQueryOne<any>(`
      SELECT
        COALESCE(SUM(commission_amount), 0)::numeric AS pending
      FROM affiliate.commissions
      WHERE status IN ('cooling_down', 'approved', 'pending')
        AND created_at >= date_trunc('month', NOW())
    `);

    const activeKOLs = await pgQueryOne<any>(`
      SELECT COUNT(DISTINCT promoter_id)::int AS active
      FROM affiliate.commissions
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);

    const byStatus = await pgQuery<any>(`
      SELECT status, COUNT(*)::int AS count, COALESCE(SUM(commission_amount), 0)::numeric AS amount
      FROM affiliate.commissions
      WHERE created_at >= date_trunc('month', NOW())
      GROUP BY status
    `);

    const commissionsByStatus: Record<string, { count: number; amount: number }> = {};
    for (const row of byStatus) {
      commissionsByStatus[row.status] = {
        count: Number(row.count),
        amount: Number(row.amount),
      };
    }

    const topKOLs = await pgQuery<any>(`
      SELECT
        p.id, p.name,
        COALESCE(SUM(c.order_amount), 0)::numeric AS gmv,
        COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status = 'paid'), 0)::numeric AS commission
      FROM affiliate.promoters p
      LEFT JOIN affiliate.commissions c ON c.promoter_id = p.id
        AND c.created_at >= date_trunc('month', NOW())
      GROUP BY p.id, p.name
      ORDER BY commission DESC
      LIMIT 10
    `);

    res.json({
      gmv: Number(thisMonth?.gmv || 0),
      paidCommission: Number(paidCommissions?.paid || 0),
      pendingCommission: Number(pendingCommissions?.pending || 0),
      activeKOLs: Number(activeKOLs?.active || 0),
      commissions: commissionsByStatus,
      ranking: topKOLs.map((k) => ({
        id: k.id,
        name: k.name,
        gmv: Number(k.gmv),
        commission: Number(k.commission),
      })),
    });
  } catch (e: any) {
    logger.error({ err: e }, "getDashboardStats failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: e.message } });
  }
}
