import { Router } from "express";
import { adminAuthMiddleware } from "../../middleware/admin-auth.js";
import {
  manualPayout,
  triggerBatchPayout,
  listPromoters,
  getPromoter,
  updatePromoter,
  suspendPromoter,
  activatePromoter,
  listCodes,
  listCommissions,
  approveCommission,
  reverseCommission,
  listRefunds,
  listPayouts,
  listAuditLogs,
  getDashboardStats,
  getFunnel,
} from "./admin.controller.js";
import { listAgents, listAgentKols, deleteAgent } from "./agents.controller.js";
import { listFraudFlags, resolveFraudFlag } from "../fraud/fraud.admin.controller.js";
import { getSigningsByEmail } from "./signings.controller.js";
import { getTaxFormSignedUrl, postStripeReset } from "./kyc.controller.js";
import { resendAgentInvite } from "../notifications/notifications.service.js";
import { logger } from "../../utils/logger.js";
import { ResendError } from "../notifications/notifications.service.js";
import { notificationsRouter } from "../notifications/notifications.routes.js";

export const adminRouter = Router();

// All admin routes require Supabase JWT + (optional) 2FA TOTP code.
// (Phase A: real Supabase auth via adminAuthMiddleware)
adminRouter.use(adminAuthMiddleware);

// Dashboard
adminRouter.get("/dashboard", getDashboardStats);

// Funnel report (read-only; same JWT + is_admin gate as dashboard)
adminRouter.get("/funnel", getFunnel);

// Payouts (Phase 3)
adminRouter.post("/payout/manual", manualPayout);
adminRouter.post("/payout/batch", triggerBatchPayout);

// Promoters
adminRouter.get("/promoters", listPromoters);
adminRouter.get("/promoters/:id", getPromoter);
adminRouter.patch("/promoters/:id", updatePromoter);
adminRouter.post("/promoters/:id/suspend", suspendPromoter);
adminRouter.post("/promoters/:id/activate", activatePromoter);

// Agents (admin view: list agents + their recruited KOLs)
adminRouter.get("/agents", listAgents);
adminRouter.get("/agents/:agentId/kols", listAgentKols);
adminRouter.delete("/agents/:agentId", deleteAgent);

// Resend agent invite (Task 1.4). Admin-only; 60s debounce is enforced
// inside resendAgentInvite. The route maps ResendError.code → HTTP status
// (404 AGENT_NOT_FOUND, 429 RESEND_TOO_SOON, 500 otherwise).
adminRouter.post("/agents/:id/resend-invite", async (req, res) => {
  const adminUser = (req as { adminUser?: { id?: string; email?: string } }).adminUser;
  const actorId = adminUser?.id ?? "00000000-0000-0000-0000-000000000000";
  const actorEmail = adminUser?.email ?? "admin@resend-invite";
  try {
    const result = await resendAgentInvite({
      promoterId: req.params.id,
      actorId,
      actorEmail,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ResendError) {
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
      return;
    }
    logger.error(
      { err: (err as Error).message, promoterId: req.params.id },
      "resend-invite failed",
    );
    res.status(500).json({ error: { code: "RESEND_FAILED", message: "Internal error" } });
  }
});

// Codes
adminRouter.get("/codes", listCodes);

// Commissions
adminRouter.get("/commissions", listCommissions);
adminRouter.post("/commissions/:id/approve", approveCommission);
adminRouter.post("/commissions/:id/reverse", reverseCommission);

// Refunds (read-only)
adminRouter.get("/refunds", listRefunds);

// Fraud review queue (self-referral anti-fraud L3)
adminRouter.get("/fraud-flags", listFraudFlags);
adminRouter.post("/fraud-flags/:id/resolve", resolveFraudFlag);

// Payouts (read-only)
adminRouter.get("/payouts", listPayouts);

// Audit logs (read-only)
adminRouter.get("/audit-logs", listAuditLogs);

// Document signings (audit-only; supports E2E assertion that fresh
// KOL register writes both NDA + Affiliate Agreement documents.signings
// rows atomically — closes audit 🟡 R4).
adminRouter.get("/signings", getSigningsByEmail);

// KYC view (admin-only): signed tax-form PDF URL + Stripe onboarding reset link
adminRouter.get("/promoters/:id/tax-form-url", getTaxFormSignedUrl);
adminRouter.post("/promoters/:id/stripe-reset", postStripeReset);

// Task 3.2: manual resend of failed affiliate_email_sends rows.
adminRouter.use("/notifications", notificationsRouter);
