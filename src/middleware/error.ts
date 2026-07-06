import { ErrorRequestHandler } from "express";
import { logger } from "../utils/logger.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, "unhandled error");

  if (err.name === "ZodError") {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid input", details: err.issues } });
    return;
  }

  if ((err as any).code === "UNAUTHORIZED") {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: (err as Error).message } });
    return;
  }

  if ((err as any).code === "NOT_FOUND") {
    res.status(404).json({ error: { code: "NOT_FOUND", message: (err as Error).message } });
    return;
  }

  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};