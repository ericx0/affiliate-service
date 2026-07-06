import express from "express";
import pinoHttp from "pino-http";
import { env } from "./config.js";
import { logger } from "./utils/logger.js";
import { hmacMiddleware } from "./middleware/hmac.js";
import { errorHandler } from "./middleware/error.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { handleStripeWebhook } from "./modules/payouts/stripe-webhook.controller.js";

const app = express();

app.use(pinoHttp({ logger }));

// Webhook route needs raw body — register BEFORE express.json()
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

// Capture raw body for HMAC verification (before JSON parse)
app.use((req, _res, next) => {
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      (req as any).rawBody = data;
      // Re-parse JSON for downstream handlers
      if (req.headers["content-type"]?.includes("application/json")) {
        try { req.body = JSON.parse(data); } catch { /* ignore */ }
      }
      next();
    });
  } else {
    next();
  }
});
app.use(express.json({ limit: "1mb" }));
app.use(hmacMiddleware(env.LCM_AFFILIATE_SECRET));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "affiliate-service" }));

app.use("/api/affiliate/orders", ordersRouter);
// TODO: register more routers as tasks complete

app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "affiliate-service listening");
});

export { app };