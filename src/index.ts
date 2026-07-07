import express from "express";
import pinoHttp from "pino-http";
import { env } from "./config.js";
import { logger } from "./utils/logger.js";
import { hmacMiddleware } from "./middleware/hmac.js";
import { errorHandler } from "./middleware/error.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { promotersRouter } from "./modules/promoters/promoters.routes.js";
import { adminAuthRouter } from "./modules/auth/auth.routes.js";
import { handleStripeWebhook } from "./modules/payouts/stripe-webhook.controller.js";
import { startCooldownApprovalJob } from "./jobs/approve-expired-cooldown.js";
import { startMonthlyPayoutJob } from "./jobs/monthly-payout-batch.js";

const app = express();

app.use(pinoHttp({ logger }));

// Webhook route needs raw body — register BEFORE express.json()
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

// Parse JSON body + capture raw body via body-parser's verify hook.
// This is the supported way to get rawBody alongside parsed body,
// avoiding the "stream is not readable" / "stream encoding should not be set"
// errors that come with manually reading the stream before body-parser.
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf.toString("utf8");
  },
}));

// Health check — unauthenticated, no HMAC
app.get("/health", (_req, res) => res.json({ status: "ok", service: "affiliate-service" }));

// HMAC verification for /api/affiliate/orders, /admin, /promoters (internal service-to-service)
// /api/affiliate/auth/admin/* uses Supabase JWT (admin user auth) — no HMAC
app.use("/api/affiliate/orders", ordersRouter);
app.use("/api/affiliate/admin", hmacMiddleware(env.LCM_AFFILIATE_SECRET), adminRouter);
app.use("/api/affiliate/promoters", hmacMiddleware(env.LCM_AFFILIATE_SECRET), promotersRouter);
app.use("/api/affiliate/auth/admin", adminAuthRouter);

app.use(errorHandler);

// Only start the server (listen + cron) when running as a standalone Node process.
// On Vercel serverless, we just export the app — Vercel invokes it as a function
// and cron jobs are dispatched via Vercel Cron separately.
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "affiliate-service listening");

    if (env.NODE_ENV !== "test") {
      startCooldownApprovalJob();
      startMonthlyPayoutJob();
    }
  });
}

export default app;
export { app };