import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import {
  getMyStats,
  getMyEarnings,
  getMyCodes,
  getMyPayouts,
  getMe,
  updateMe,
  createMyCode,
  submitMyTaxForm,
  getMyTaxForm,
} from "./me.controller.js";
import {
  postMyStripeConnect,
  getMyStripeStatus,
} from "./stripe-connect.controller.js";

export const meRouter = Router();

// All KOL endpoints require an authenticated session whose email
// matches a promoter row. See kolAuthMiddleware for details.
meRouter.use(kolAuthMiddleware);

meRouter.get("/stats", getMyStats);
meRouter.get("/earnings", getMyEarnings);
meRouter.get("/codes", getMyCodes);
meRouter.post("/codes", createMyCode);
meRouter.get("/payouts", getMyPayouts);
meRouter.get("/tax-form", getMyTaxForm);
meRouter.post("/tax-form", submitMyTaxForm);
// The portal calls GET/PATCH /api/affiliate/me (router root). "/me" is
// kept for backward compatibility; "/profile" is the explicit alias the
// portal uses for the review-state contract (profile.status).
meRouter.get("/", getMe);
meRouter.get("/me", getMe);
meRouter.get("/profile", getMe);
meRouter.patch("/", updateMe);
meRouter.get("/stripe-status", getMyStripeStatus);
meRouter.post("/stripe-connect", postMyStripeConnect);
