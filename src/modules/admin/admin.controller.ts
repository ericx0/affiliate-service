import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { paySingleCommission, payCommissions } from "../payouts/payouts.service.js";
import { writeAuditLog } from "./audit.service.js";

const adminCtx = (req: Request) => ({
  adminId: (req as any).adminId || "00000000-0000-0000-0000-000000000000",
  adminEmail: (req as any).adminEmail || "unknown@linkchinamed.com",
});

// ============================================================
// PAYOUT endpoints (Phase 3) — unchanged
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
// Phase A5: All admin endpoints use public schema RPC functions
// (avoids PostgREST schema cache for affiliate.* tables/views,
//  and avoids Vercel serverless inability to do raw TCP to db.*)
// ============================================================

const ListPromotersSchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  platform: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export async function listPromoters(req: Request, res: Response) {
  const filters = ListPromotersSchema.parse(req.query);
  const { data, error } = await supabase.rpc("affiliate_list_promoters", {
    p_search: filters.search || null,
    p_status: filters.status || null,
    p_platform: filters.platform || null,
    p_limit: filters.limit,
    p_offset: filters.offset,
  });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}

export async function getPromoter(req: Request, res: Response) {
  const { id } = req.params;
  const { data, error } = await supabase.rpc("affiliate_get_promoter", { p_id: id });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  if (!data) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
  res.json(data);
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

  const { data: before } = await supabase.rpc("affiliate_get_promoter", { p_id: id });
  if (!before) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });

  const { data, error } = await supabase.rpc("affiliate_update_promoter", {
    p_id: id,
    p_commission_rate: updates.commission_rate ?? null,
    p_commission_type: updates.commission_type ?? null,
    p_override_reason: updates.override_reason ?? null,
    p_status: updates.status ?? null,
    p_actor_id: ctx.adminId,
  });

  if (error) return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "update_promoter",
    targetType: "promoter",
    targetId: id,
    beforeState: before,
    afterState: data,
    reason: updates.override_reason || "admin update",
  });

  res.json(data);
}

const SuspendSchema = z.object({ reason: z.string().min(1) });

export async function suspendPromoter(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = SuspendSchema.parse(req.body);
  const ctx = adminCtx(req);

  const { data: before } = await supabase.rpc("affiliate_get_promoter", { p_id: id });
  if (!before) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });

  const { data, error } = await supabase.rpc("affiliate_suspend_promoter", {
    p_id: id,
    p_reason: reason,
  });
  if (error) return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "suspend",
    targetType: "promoter",
    targetId: id,
    beforeState: before,
    afterState: data,
    reason,
  });

  res.json(data);
}

export async function activatePromoter(req: Request, res: Response) {
  const { id } = req.params;
  const ctx = adminCtx(req);

  const { data: before } = await supabase.rpc("affiliate_get_promoter", { p_id: id });
  if (!before) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });

  const { data, error } = await supabase.rpc("affiliate_activate_promoter", { p_id: id });
  if (error) return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "activate",
    targetType: "promoter",
    targetId: id,
    beforeState: before,
    afterState: data,
    reason: "admin activate",
  });

  res.json(data);
}

const ListCodesSchema = z.object({
  promoter_id: z.string().uuid().optional(),
  is_active: z.coerce.boolean().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export async function listCodes(req: Request, res: Response) {
  const filters = ListCodesSchema.parse(req.query);
  const { data, error } = await supabase.rpc("affiliate_list_codes", {
    p_promoter_id: filters.promoter_id || null,
    p_is_active: filters.is_active ?? null,
    p_limit: filters.limit,
    p_offset: filters.offset,
  });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}

const ListCommissionsSchema = z.object({
  promoter_id: z.string().uuid().optional(),
  status: z.string().optional(),
  month_key: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export async function listCommissions(req: Request, res: Response) {
  const filters = ListCommissionsSchema.parse(req.query);
  const { data, error } = await supabase.rpc("affiliate_list_commissions", {
    p_promoter_id: filters.promoter_id || null,
    p_status: filters.status || null,
    p_month_key: filters.month_key || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_limit: filters.limit,
    p_offset: filters.offset,
  });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}

const CommissionActionSchema = z.object({ reason: z.string().min(1) });

export async function approveCommission(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = CommissionActionSchema.parse(req.body);
  const ctx = adminCtx(req);

  const { data, error } = await supabase.rpc("affiliate_approve_commission", {
    p_id: id,
    p_reason: reason,
  });
  if (error) return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });
  if (data?.error) {
    if (data.error === "not_found") return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (data.error === "invalid_state") {
      return res.status(400).json({ error: { code: "INVALID_STATE", message: `Cannot approve, current: ${data.current}` } });
    }
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "approve_commission",
    targetType: "commission",
    targetId: id,
    afterState: data,
    reason,
  });

  res.json(data);
}

export async function reverseCommission(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = CommissionActionSchema.parse(req.body);
  const ctx = adminCtx(req);

  // First check current state
  const { data: current } = await supabase
    .from("commissions")
    .select("status, commission_amount, stripe_transfer_id")
    .eq("id", id)
    .single();

  if (!current) return res.status(404).json({ error: { code: "NOT_FOUND" } });
  if (current.status !== "paid") {
    return res.status(400).json({ error: { code: "INVALID_STATE", message: `Can only reverse paid, current: ${current.status}` } });
  }
  if (!current.stripe_transfer_id) {
    return res.status(400).json({ error: { code: "NO_TRANSFER" } });
  }

  // Reverse via Stripe
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
    await stripe.transfers.createReversal(current.stripe_transfer_id, {
      amount: Math.round(Number(current.commission_amount) * 100),
      metadata: { commissionId: id, reason, reversedBy: ctx.adminEmail },
    });
  } catch (stripeErr: any) {
    logger.error({ stripeErr, id }, "Stripe reversal failed");
    return res.status(502).json({ error: { code: "STRIPE_FAILED", message: stripeErr.message } });
  }

  // Mark reversed via RPC
  const { data, error } = await supabase.rpc("affiliate_reverse_commission", {
    p_id: id,
    p_reason: reason,
  });
  if (error) return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "reverse_commission",
    targetType: "commission",
    targetId: id,
    beforeState: current,
    afterState: data,
    reason,
  });

  res.json(data);
}

export async function listRefunds(req: Request, res: Response) {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const { data, error } = await supabase.rpc("affiliate_list_refunds", { p_limit: limit, p_offset: offset });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}

export async function listPayouts(req: Request, res: Response) {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const monthKey = (req.query.month_key as string) || null;
  const { data, error } = await supabase.rpc("affiliate_list_payouts", {
    p_month_key: monthKey,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}

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
  const { data, error } = await supabase.rpc("affiliate_list_audit_logs", {
    p_actor: filters.actor || null,
    p_action: filters.action || null,
    p_target_type: filters.target_type || null,
    p_target_id: filters.target_id || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_limit: filters.limit,
    p_offset: filters.offset,
  });
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}

export async function getDashboardStats(_req: Request, res: Response) {
  const { data, error } = await supabase.rpc("affiliate_get_dashboard_stats");
  if (error) return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  res.json(data);
}
