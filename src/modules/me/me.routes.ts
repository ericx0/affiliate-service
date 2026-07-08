import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import {
  getMyStats,
  getMyEarnings,
  getMyCodes,
  getMyPayouts,
  getMe,
  getMyStripeStatus,
} from "./me.controller.js";

export const meRouter = Router();

// All KOL endpoints require an authenticated session whose email
// matches a promoter row. See kolAuthMiddleware for details.
meRouter.use(kolAuthMiddleware);

meRouter.get("/stats", getMyStats);
meRouter.get("/earnings", getMyEarnings);
meRouter.get("/codes", getMyCodes);
meRouter.get("/payouts", getMyPayouts);
meRouter.get("/me", getMe);
meRouter.get("/stripe-status", getMyStripeStatus);
