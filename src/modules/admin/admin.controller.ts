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
// PAYOUT endpoints (Phase 3)
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
// PROMOTER endpoints (Phase 5 - missing from Phase 3)
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

  let query = supabase
    .from("v_promoter_stats")
    .select("*")
    .range(filters.offset, filters.offset + filters.limit - 1)
    .order("total_paid", { ascending: false });

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.platform) query = query.eq("primary_platform", filters.platform);
  if (filters.search) {
    query = query.or(
      `name.ilike.%${filters.search}%,email.ilike.%${filters.search}%,brand_name.ilike.%${filters.search}%`
    );
  }

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  }
  res.json(data);
}

export async function getPromoter(req: Request, res: Response) {
  const { id } = req.params;
  const { data: promoter, error: pErr } = await supabase
    .from("v_promoter_stats")
    .select("*")
    .eq("id", id)
    .single();

  if (pErr || !promoter) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
  }

  const { data: codes } = await supabase
    .from("referral_codes")
    .select("*")
    .eq("promoter_id", id)
    .order("created_at", { ascending: false });

  res.json({ ...promoter, referral_codes: codes || [] });
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

  const { data: before } = await supabase
    .from("promoters")
    .select("commission_rate, commission_type, status, override_reason")
    .eq("id", id)
    .single();

  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
  }

  const updateData: any = { ...updates, updated_at: new Date().toISOString() };
  if (updates.commission_type === "override") {
    updateData.override_by = ctx.adminId;
    updateData.override_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("promoters")
    .update(updateData)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "update_promoter",
    targetType: "promoter",
    targetId: id,
    beforeState: before,
    afterState: updateData,
    reason: updates.override_reason || "admin update",
  });

  res.json(data);
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

  const { data: before } = await supabase
    .from("promoters")
    .select("status")
    .eq("id", id)
    .single();

  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Promoter not found" } });
  }

  const updateData: any = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
  if (newStatus === "suspended") {
    updateData.suspended_reason = reason;
    updateData.suspended_at = new Date().toISOString();
  }

  const { data, error } = await supabase.from("promoters").update(updateData).eq("id", id).select().single();

  if (error) {
    return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action,
    targetType: "promoter",
    targetId: id,
    beforeState: before,
    afterState: updateData,
    reason,
  });

  res.json(data);
}

export async function suspendPromoter(req: Request, res: Response) {
  return changePromoterStatus(req, res, "suspended", "suspend");
}

export async function activatePromoter(req: Request, res: Response) {
  return changePromoterStatus(req, res, "active", "activate");
}

// ============================================================
// CODES endpoint
// ============================================================

const ListCodesSchema = z.object({
  promoter_id: z.string().uuid().optional(),
  is_active: z.coerce.boolean().optional(),
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
});

export async function listCodes(req: Request, res: Response) {
  const filters = ListCodesSchema.parse(req.query);
  let query = supabase
    .from("referral_codes")
    .select("*, promoters(name, email, brand_name)")
    .range(filters.offset, filters.offset + filters.limit - 1)
    .order("created_at", { ascending: false });
  if (filters.promoter_id) query = query.eq("promoter_id", filters.promoter_id);
  if (filters.is_active !== undefined) query = query.eq("is_active", filters.is_active);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  }
  res.json(data);
}

// ============================================================
// COMMISSIONS endpoints
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

export async function listCommissions(req: Request, res: Response) {
  const filters = ListCommissionsSchema.parse(req.query);
  let query = supabase
    .from("v_commission_timeline")
    .select("*")
    .range(filters.offset, filters.offset + filters.limit - 1)
    .order("created_at", { ascending: false });
  if (filters.promoter_id) query = query.eq("promoter_id", filters.promoter_id);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.month_key) query = query.eq("month_key", filters.month_key);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  }
  res.json(data);
}

const CommissionActionSchema = z.object({ reason: z.string().min(1) });

export async function approveCommission(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = CommissionActionSchema.parse(req.body);
  const ctx = adminCtx(req);

  const { data: before } = await supabase
    .from("commissions")
    .select("status, commission_amount")
    .eq("id", id)
    .single();
  if (!before) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Commission not found" } });
  }
  if (before.status !== "cooling_down" && before.status !== "approved") {
    return res.status(400).json({
      error: { code: "INVALID_STATE", message: `Cannot approve commission in status: ${before.status}` },
    });
  }

  const { data, error } = await supabase
    .from("commissions")
    .update({ status: "approved", approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "approve_commission",
    targetType: "commission",
    targetId: id,
    beforeState: before,
    afterState: data,
    reason,
  });

  res.json(data);
}

export async function reverseCommission(req: Request, res: Response) {
  const { id } = req.params;
  const { reason } = CommissionActionSchema.parse(req.body);
  const ctx = adminCtx(req);

  const { data: before } = await supabase
    .from("commissions")
    .select("status, commission_amount, stripe_transfer_id")
    .eq("id", id)
    .single();
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

  // Reverse via Stripe (will fail without live key — admin handles manually if so)
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
    await stripe.transfers.createReversal(before.stripe_transfer_id, {
      amount: Math.round(Number(before.commission_amount) * 100),
      metadata: { commissionId: id, reason, reversedBy: ctx.adminEmail },
    });
  } catch (stripeErr: any) {
    logger.error({ stripeErr, id }, "Stripe reversal failed — admin must reverse manually");
    return res.status(502).json({
      error: { code: "STRIPE_FAILED", message: `Stripe reversal failed: ${stripeErr.message}` },
    });
  }

  const { data, error } = await supabase
    .from("commissions")
    .update({ status: "reversed", refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: { code: "UPDATE_FAILED", message: error.message } });
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "reverse_commission",
    targetType: "commission",
    targetId: id,
    beforeState: before,
    afterState: data,
    reason,
  });

  res.json(data);
}

// ============================================================
// REFUNDS endpoint (read-only, derived from commissions.status='refunded')
// ============================================================

export async function listRefunds(req: Request, res: Response) {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const { data, error } = await supabase
    .from("v_commission_timeline")
    .select("*")
    .eq("status", "refunded")
    .range(offset, offset + limit - 1)
    .order("refunded_at", { ascending: false });
  if (error) {
    return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  }
  res.json(data);
}

// ============================================================
// PAYOUTS endpoint (read-only, derived from commissions.status='paid')
// ============================================================

export async function listPayouts(req: Request, res: Response) {
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const monthKey = req.query.month_key as string | undefined;
  let query = supabase
    .from("v_commission_timeline")
    .select("*")
    .eq("status", "paid")
    .range(offset, offset + limit - 1)
    .order("paid_at", { ascending: false });
  if (monthKey) query = query.eq("month_key", monthKey);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  }
  res.json(data);
}

// ============================================================
// AUDIT LOGS endpoint (read-only)
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
  let query = supabase
    .from("audit_logs")
    .select("*")
    .range(filters.offset, filters.offset + filters.limit - 1)
    .order("created_at", { ascending: false });
  if (filters.actor) query = query.eq("actor_id", filters.actor);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.target_type) query = query.eq("target_type", filters.target_type);
  if (filters.target_id) query = query.eq("target_id", filters.target_id);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: { code: "QUERY_FAILED", message: error.message } });
  }
  res.json(data);
}
