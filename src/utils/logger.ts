import pino from "pino";
import { env } from "../config.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact secrets that pino-http would otherwise capture from request headers.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-totp-code"]',
      'req.headers["x-lcm-signature"]',
      'req.headers.cookie',
    ],
    censor: "[REDACTED]",
  },
  ...(env.NODE_ENV === "development" && {
    transport: { target: "pino-pretty", options: { colorize: true } },
  }),
});