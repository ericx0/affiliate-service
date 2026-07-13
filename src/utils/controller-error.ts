import { Response } from "express";
import { logger } from "./logger.js";

/**
 * 5xx response helper. Logs the full error server-side (so the operator
 * can still see it) but returns a generic message to the client — never
 * leak `err.message` which can contain DB constraint names, table names,
 * or other schema details useful to an attacker.
 *
 * Use instead of:
 *   res.status(500).json({ error: { code: "...", message: err.message } });
 */
export function internalError(
  res: Response,
  code: string,
  err: unknown,
  context?: Record<string, unknown>,
): Response {
  logger.error(
    { err, code, ...context },
    "internal error returned as 500",
  );
  return res.status(500).json({
    error: {
      code,
      message: "Internal server error",
    },
  });
}
