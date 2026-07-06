import { Router } from "express";
import { manualPayout, triggerBatchPayout } from "./admin.controller.js";
import { requireRole } from "../../middleware/admin-auth.js";

export const adminRouter = Router();

adminRouter.post("/payout/manual", requireRole(["finance", "super_admin"]), manualPayout);
adminRouter.post("/payout/batch", requireRole(["finance", "super_admin"]), triggerBatchPayout);
// TODO: register more admin routes in later tasks