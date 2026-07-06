import express from "express";
import pinoHttp from "pino-http";
import { env } from "./config.js";
import { logger } from "./utils/logger.js";
import { hmacMiddleware } from "./middleware/hmac.js";
import { errorHandler } from "./middleware/error.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";

const app = express();

app.use(pinoHttp({ logger }));

// Webhook route needs raw body — register BEFORE express.json()
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (_req, _res) => {
  // TODO: Task 3.4 — wire up Stripe webhook
});

// All other routes use JSON + HMAC verification
app.use(express.json({ limit: "1mb" }));
app.use(hmacMiddleware); // verifies X-LCM-Signature

app.get("/health", (_req, res) => res.json({ status: "ok", service: "affiliate-service" }));

app.use("/api/affiliate/orders", ordersRouter);
// TODO: register more routers as tasks complete

app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "affiliate-service listening");
});

export { app };