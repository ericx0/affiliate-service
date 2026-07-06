import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { paySingleCommission, payCommissions } from "../payouts/payouts.service.js";
import { writeAuditLog } from "./audit.service.js";

const ManualPayoutSchema = z.object({
  commissionId: z.string().uuid(),
  reason: z.string().min(1),
});

export async function manualPayout(req: Request, res: Response) {
  const { commissionId, reason } = ManualPayoutSchema.parse(req.body);
  const adminEmail = (req as any).adminEmail || "unknown@linkchinamed.com";
  const adminId = (req as any).adminId || "00000000-0000-0000-0000-000000000000";

  // Get current state for audit
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

  // Audit log
  await writeAuditLog({
    actorId: adminId,
    actorEmail: adminEmail,
    action: "manual_payout",
    targetType: "commission",
    targetId: commissionId,
    beforeState: before,
    afterState: { status: "paid", paid_at: new Date().toISOString() },
    reason,
  });

  logger.info({ commissionId, adminEmail, reason }, "manual payout executed");
  res.json({ success: true, transferId: result.transferId, totalAmount: result.totalAmount });
}

const BatchPayoutSchema = z.object({
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function triggerBatchPayout(req: Request, res: Response) {
  const { monthKey } = BatchPayoutSchema.parse(req.body);
  const adminEmail = (req as any).adminEmail || "unknown@linkchinamed.com";

  // Get all approved commissions
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
    actorId: req.body.adminId || "00000000-0000-0000-0000-000000000000",
    actorEmail: adminEmail,
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