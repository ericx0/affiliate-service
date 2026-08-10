import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { env } from "./config.js";
import { logger } from "./utils/logger.js";
import { hmacMiddleware } from "./middleware/hmac.js";
import { errorHandler } from "./middleware/error.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { clicksRouter } from "./modules/clicks/clicks.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { promotersRouter } from "./modules/promoters/promoters.routes.js";
import { adminAuthRouter } from "./modules/auth/auth.routes.js";
import { checkEmailRouter } from "./modules/auth/check-email.routes.js";
import { meRouter } from "./modules/me/me.routes.js";
import { codesRouter } from "./modules/codes/codes.routes.js";
import { registerRouter } from "./modules/auth/register.routes.js";
import { agentRouter } from "./modules/agents/agents.routes.js";
import { handleStripeWebhook } from "./modules/payouts/stripe-webhook.controller.js";
import { startCooldownApprovalJob } from "./jobs/approve-expired-cooldown.js";
import { startMonthlyPayoutJob } from "./jobs/monthly-payout-batch.js";
import { cronRouter } from "./modules/cron/cron.routes.js";
import { clientsRouter } from "./modules/clients/clients.routes.js";
import { tasksRouter } from "./modules/tasks/tasks.routes.js";
import { socialRouter } from "./modules/social/social.routes.js";
import { casesRouter } from "./modules/cases/cases.routes.js";
import { emailTemplatesRouter } from "./modules/email-templates/email-templates.routes.js";
import { funnelRouter } from "./modules/funnel/funnel.routes.js";

const app = express();

// CORS — allow the KOL portal to call this service cross-origin.
// Without this, every browser fetch fails at the preflight stage.
app.use(cors({
  origin: [
    "https://affiliate.linkchinamed.com",
    "https://adminss.linkchinamed.com",
    "https://adminv2.linkchinamed.com",
  ],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-TOTP-Code"],
  credentials: false,
}));

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc).
// Skip for the Stripe webhook — it doesn't need these and Stripe's
// content-type detection stays correct. Also skip the social OAuth
// callback so Meta/Google/etc can redirect without frame restrictions
// getting in the way of their redirect URIs.
app.use((req, res, next) => {
  if (req.path === "/webhooks/stripe") return next();
  if (req.path.startsWith("/api/social/oauth/")) return next();
  return helmet()(req, res, next);
});

// Rate limit login / TOTP-verify / register endpoints (the brute-force
// targets). express-rate-limit is in-memory per process; on Vercel
// serverless multiple instances means effective limit is N× — acceptable
// for low-stakes auth (TOTP is the real defence), tighten if abuse.
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10, // 10 requests / minute / IP per route prefix
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// Click tracking is public (no HMAC/JWT) and called server-side by the
// main-site edge middleware. Generous limit: one edge worker can legitimately
// fire many tracks from the same egress IP; the limit only stops abuse.
const clickLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120, // 120 requests / minute / IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

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

// Routes:
//   /api/affiliate/orders/*       — HMAC (service-to-service from main-site)
//   /api/affiliate/admin/*        — JWT + 2FA (admin user login via chinamed-admin)
//   /api/affiliate/promoters/*    — JWT + 2FA (admin creates KOL)
//   /api/affiliate/auth/admin/*   — JWT only (setup 2FA itself)
//   /api/affiliate/me/*           — KOL self-service (dashboard data)
//   /api/affiliate/auth/register  — KOL self-registration (signed in, email-verified)
//   /api/affiliate/clicks/*       — public click tracking (rate-limited, always 204)
//   /api/affiliate/clients/*      — KOL self-service (CRUD + contact log)
//   /api/affiliate/tasks/*        — KOL self-service (complete followup tasks)
app.use("/api/affiliate/orders", hmacMiddleware(env.LCM_AFFILIATE_SECRET), ordersRouter);
app.use("/api/affiliate/clicks", clickLimiter, clicksRouter);  // public — no HMAC/JWT
app.use("/api/affiliate/admin", authLimiter, adminRouter);   // adminAuthMiddleware inside adminRouter
app.use("/api/affiliate/promoters", authLimiter, promotersRouter);  // adminAuthMiddleware inside promotersRouter
app.use("/api/affiliate/auth", checkEmailRouter);
app.use("/api/affiliate/auth/admin", authLimiter, adminAuthRouter);
app.use("/api/affiliate/me", authLimiter, meRouter);
app.use("/api/affiliate", authLimiter, codesRouter);
app.use("/api/affiliate/clients", authLimiter, clientsRouter);
app.use("/api/affiliate/tasks", authLimiter, tasksRouter);
app.use("/api/affiliate/agent", authLimiter, agentRouter);
app.use("/api/affiliate/auth/register", authLimiter, registerRouter);
app.use("/api/affiliate/cron", cronRouter);
// Batch 8e-P0 / T1: multi-platform social publishing.
// OAuth callback route is unauthenticated (HMAC-signed state token
// binds the callback to the promoter). All other endpoints require
// the KOL session (enforced inside the router).
app.use("/api/social", authLimiter, socialRouter);
// Batch 8e-P0 / T2: real case library + AI rewrite.
app.use("/api/affiliate/cases", authLimiter, casesRouter);
// Batch 8e-P0 / T3: multi-language email / DM templates.
app.use("/api/affiliate/email-templates", authLimiter, emailTemplatesRouter);
// Batch 8e-P0 / T4: cross-platform UTM funnel dashboard.
app.use("/api/affiliate/funnel", authLimiter, funnelRouter);

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