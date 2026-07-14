import { Router } from "express";
import crypto from "node:crypto";
import { logger } from "../../utils/logger.js";
import { approveExpiredCooldowns } from "../commissions/commissions.service.js";
import { payCommissions } from "../payouts/payouts.service.js";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

const cronRouter = Router();

// Ensure the request comes from Vercel Cron
cronRouter.use((req, res, next) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("CRON_SECRET is not configured — refusing all cron requests");
    return res.status(503).json({ error: "Cron not configured" });
  }
  const authHeader = req.headers.authorization;
  // AS-P2-11 fix: timingSafeEqual for the bearer comparison. String
  // === is technically constant-time-ish in V8 (no early-exit on
  // length-mismatch since we check length first) but using the
  // canonical helper is defense-in-depth and consistent with the
  // hmac middleware's signing-compare pattern.
  const expected = `Bearer ${cronSecret}`;
  const provided = authHeader ?? "";
  if (provided.length !== expected.length) {
    logger.warn("Unauthorized attempt to hit cron endpoint");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const ok = crypto.timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(expected),
  );
  if (!ok) {
    logger.warn("Unauthorized attempt to hit cron endpoint");
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

cronRouter.get("/approve-cooldown", async (_req, res) => {
  try {
    const approved = await approveExpiredCooldowns();
    return res.json({ success: true, approved });
  } catch (err: any) {
    logger.error({ err }, "Cron: approve-cooldown failed");
    return internalError(res, "CRON_FAILED", err);
  }
});

cronRouter.get("/monthly-payout", async (_req, res) => {
  try {
    const { data: approved, error } = await supabase
      .from("commissions")
      .select("id")
      .eq("status", "approved");

    if (error) throw error;
    if (!approved || approved.length === 0) {
      return res.json({ success: true, message: "No approved commissions to pay" });
    }

    const commissionIds = approved.map((c: any) => c.id);
    const results = await payCommissions(commissionIds);
    const successful = results.filter((r) => r.success).length;

    return res.json({ success: true, total: results.length, successful });
  } catch (err: any) {
    logger.error({ err }, "Cron: monthly-payout failed");
    return internalError(res, "CRON_FAILED", err);
  }
});

export { cronRouter };
