import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { transition } from "../commissions/commissions.service.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";

/**
 * Admin fraud-review endpoints (L3 of the self-referral anti-fraud
 * design). Mounted under /api/affiliate/admin (adminAuthMiddleware).
 *
 *   GET  /fraud-flags?status=open   — review queue
 *   POST /fraud-flags/:id/resolve   — { action: 'dismiss' | 'confirm' }
 *
 * dismiss  → flag closed; commission stays approved and becomes payable
 *            in the next batch.
 * confirm  → flag closed as confirmed_fraud; the linked commission (if
 *            any) transitions to 'voided' (terminal, never paid), per
 *            Code of Conduct §7 breach-linked recovery.
 */

const ResolveSchema = z.object({
  action: z.enum(["dismiss", "confirm"]),
  note: z.string().max(1000).optional(),
});

export async function listFraudFlags(req: Request, res: Response) {
  const status = typeof req.query.status === "string" ? req.query.status : "open";
  let query = supabase
    .from("affiliate.fraud_flags")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return internalError(res, "FRAUD_FLAGS_QUERY_FAILED", error);
  res.json({ data });
}

export async function resolveFraudFlag(req: Request, res: Response) {
  const parsed = ResolveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const adminEmail = req.adminUser?.email ?? "unknown";

  const { data: flag, error: flagErr } = await supabase
    .from("affiliate.fraud_flags")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (flagErr || !flag) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Fraud flag not found" } });
  }
  if (flag.status !== "open") {
    return res.status(409).json({ error: { code: "ALREADY_RESOLVED", message: `Flag already ${flag.status}` } });
  }

  // On confirm, void the linked commission FIRST so a payout can never
  // slip through between the flag update and the void.
  if (parsed.data.action === "confirm" && flag.commission_id) {
    const result = await transition(flag.commission_id, "voided", {
      void_reason: `fraud_confirmed:${flag.flag_type}`,
      fraud_flag_id: flag.id,
      resolved_by: adminEmail,
    });
    if (!result.success) {
      logger.error(
        { flagId: flag.id, commissionId: flag.commission_id, error: result.error },
        "fraud confirm failed: commission void did not apply",
      );
      return internalError(res, "VOID_FAILED", result);
    }
  }

  const { error: updErr } = await supabase
    .from("affiliate.fraud_flags")
    .update({
      status: parsed.data.action === "confirm" ? "confirmed_fraud" : "dismissed",
      resolution_note: parsed.data.note ?? null,
      resolved_by: adminEmail,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", flag.id)
    .eq("status", "open"); // CAS: another admin may have resolved it first
  if (updErr) return internalError(res, "FLAG_UPDATE_FAILED", updErr);

  logger.warn(
    { flagId: flag.id, action: parsed.data.action, promoterId: flag.promoter_id, adminEmail },
    "fraud flag resolved",
  );
  res.json({ success: true, action: parsed.data.action, commissionVoided: parsed.data.action === "confirm" && !!flag.commission_id });
}
