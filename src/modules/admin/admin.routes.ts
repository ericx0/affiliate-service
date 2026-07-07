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
} from "./admin.controller.js";

export const adminRouter = Router();

// All admin routes require Supabase JWT + (optional) 2FA TOTP code.
// (Phase A: real Supabase auth via adminAuthMiddleware)
adminRouter.use(adminAuthMiddleware);

// Dashboard
adminRouter.get("/dashboard", getDashboardStats);

// Payouts (Phase 3)
adminRouter.post("/payout/manual", manualPayout);
adminRouter.post("/payout/batch", triggerBatchPayout);

// Promoters
adminRouter.get("/promoters", listPromoters);
adminRouter.get("/promoters/:id", getPromoter);
adminRouter.patch("/promoters/:id", updatePromoter);
adminRouter.post("/promoters/:id/suspend", suspendPromoter);
adminRouter.post("/promoters/:id/activate", activatePromoter);

// Codes
adminRouter.get("/codes", listCodes);

// Commissions
adminRouter.get("/commissions", listCommissions);
adminRouter.post("/commissions/:id/approve", approveCommission);
adminRouter.post("/commissions/:id/reverse", reverseCommission);

// Refunds (read-only)
adminRouter.get("/refunds", listRefunds);

// Payouts (read-only)
adminRouter.get("/payouts", listPayouts);

// Audit logs (read-only)
adminRouter.get("/audit-logs", listAuditLogs);
