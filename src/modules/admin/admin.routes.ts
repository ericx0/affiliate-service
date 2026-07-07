import { Router } from "express";
import { requireRole } from "../../middleware/admin-auth.js";
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
} from "./admin.controller.js";

export const adminRouter = Router();

const READ_ROLES = ["kol_manager", "finance", "super_admin", "compliance", "viewer"];
const WRITE_ROLES = ["kol_manager", "finance", "super_admin"];

// Payouts (Phase 3)
adminRouter.post("/payout/manual", requireRole(WRITE_ROLES), manualPayout);
adminRouter.post("/payout/batch", requireRole(WRITE_ROLES), triggerBatchPayout);

// Promoters
adminRouter.get("/promoters", requireRole(READ_ROLES), listPromoters);
adminRouter.get("/promoters/:id", requireRole(READ_ROLES), getPromoter);
adminRouter.patch("/promoters/:id", requireRole(WRITE_ROLES), updatePromoter);
adminRouter.post("/promoters/:id/suspend", requireRole(WRITE_ROLES), suspendPromoter);
adminRouter.post("/promoters/:id/activate", requireRole(WRITE_ROLES), activatePromoter);

// Codes
adminRouter.get("/codes", requireRole(READ_ROLES), listCodes);

// Commissions
adminRouter.get("/commissions", requireRole(READ_ROLES), listCommissions);
adminRouter.post("/commissions/:id/approve", requireRole(WRITE_ROLES), approveCommission);
adminRouter.post("/commissions/:id/reverse", requireRole(WRITE_ROLES), reverseCommission);

// Refunds (read-only)
adminRouter.get("/refunds", requireRole(READ_ROLES), listRefunds);

// Payouts (read-only — distinguish from POST /payout/*)
adminRouter.get("/payouts", requireRole(READ_ROLES), listPayouts);

// Audit logs (read-only)
adminRouter.get("/audit-logs", requireRole(READ_ROLES), listAuditLogs);
