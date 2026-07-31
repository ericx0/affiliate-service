import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import {
  disconnectAccount,
  listHistory,
  listMyAccounts,
  oauthCallback,
  oauthStart,
  publishNow,
  refreshMetrics,
  schedulePost,
} from "./social.controller.js";

export const socialRouter = Router();

/* The OAuth callback is unauthenticated — it runs in the user's browser
 * after the platform redirected them back. State-token HMAC binds the
 * callback to the promoter id that initiated it. */
socialRouter.get("/oauth/:platform/callback", oauthCallback);

// Everything else requires an authenticated KOL session.
socialRouter.use(kolAuthMiddleware);

socialRouter.get("/accounts", listMyAccounts);
socialRouter.get("/oauth/:platform/start", oauthStart);
socialRouter.delete("/accounts/:platform", disconnectAccount);

socialRouter.post("/publish", publishNow);
socialRouter.post("/schedule", schedulePost);
socialRouter.get("/history", listHistory);
socialRouter.post("/refresh-metrics", refreshMetrics);
