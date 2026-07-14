import pino from "pino";
import { env } from "../config.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  // AS-P2-10 fix: also redact req.body. The Stripe webhook payload
  // (which we log via pino-http) includes customer email, charge
  // billing details, and full metadata — all PII / financial.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-totp-code"]',
      'req.headers["x-lcm-signature"]',
      'req.headers.cookie',
      'req.body',
      // Stripe-specific nested paths (defense in depth — also covered
      // by the blanket req.body above).
      'req.body.data.object.customer',
      'req.body.data.object.billing_details',
    ],
    censor: "[REDACTED]",
  },
  ...(env.NODE_ENV === "development" && {
    transport: { target: "pino-pretty", options: { colorize: true } },
  }),
});