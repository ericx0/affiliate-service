import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { kolOrAgentAuthMiddleware } from "../../middleware/kol-or-agent-auth.js";
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
  getDashboardAggregate,
  getMyNotificationPrefs,
  patchMyNotificationPrefs,
} from "./me.controller.js";
import {
  postMyStripeConnect,
  getMyStripeStatus,
} from "./stripe-connect.controller.js";
import { getMyAnalytics } from "./analytics/analytics.controller.js";
import { getMyTaxDocs } from "./tax-docs.controller.js";
import { getMyProjection } from "./projection.controller.js";

export const meRouter = Router();

// Stripe Connect onboarding is shared by both the KOL portal and the
// Agent portal — both roles earn commissions and need a Connect
// account to receive payouts. Mounted on a sub-router with
// `kolOrAgentAuthMiddleware` so KOLs authenticate as KOLs and Agents
// authenticate as Agents, both ending up at the same handler with
// `req.subject` populated.
const stripeConnectRouter = Router();
stripeConnectRouter.use(kolOrAgentAuthMiddleware);
stripeConnectRouter.get("/stripe-status", getMyStripeStatus);
stripeConnectRouter.post("/stripe-connect", postMyStripeConnect);
meRouter.use(stripeConnectRouter);

// All other KOL endpoints require an authenticated session whose
// email matches a promoter row. See kolAuthMiddleware for details.
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
// Batch 8a: dashboard analytics, tax docs, commission projection.
meRouter.get("/analytics", getMyAnalytics);
meRouter.get("/tax-docs", getMyTaxDocs);
meRouter.get("/commission-projection", getMyProjection);
meRouter.get("/dashboard-aggregate", getDashboardAggregate);
// Task 3.2: per-KOL notification opt-out (commission_pending /
// commission_reversed / payout_sent / payout_failed / new_referral).
meRouter.get("/notification-prefs", getMyNotificationPrefs);
meRouter.patch("/notification-prefs", patchMyNotificationPrefs);
