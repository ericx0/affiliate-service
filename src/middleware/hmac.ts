import { RequestHandler } from "express";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";

/**
 * Verifies HMAC signature from main-site webhook calls.
 * Header: X-LCM-Signature: sha256=<hex>
 */
export function hmacMiddleware(secret: string = process.env.LCM_AFFILIATE_SECRET || ""): RequestHandler {
  return (req, res, next) => {
    if (!secret) {
      logger.error("LCM_AFFILIATE_SECRET not set");
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "HMAC secret not configured" } });
      return;
    }

    const sigHeader = req.headers["x-lcm-signature"];
    if (!sigHeader || typeof sigHeader !== "string" || !sigHeader.startsWith("sha256=")) {
      logger.warn({ path: req.path }, "missing or malformed X-LCM-Signature");
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid signature" } });
      return;
    }

    const providedSig = sigHeader.slice(7); // strip "sha256="
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const expectedSig = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    // Debug: log hash inputs (TEMPORARY for debugging)
    logger.warn({
      path: req.path,
      method: req.method,
      rawBodyLen: rawBody.length,
      rawBodyPreview: rawBody.substring(0, 80),
      secretLen: secret.length,
      secretTail: secret.substring(secret.length - 4),
      providedSigLen: providedSig.length,
      expectedSigTail: expectedSig.substring(0, 8),
    }, "HMAC debug");

    const providedBuf = Buffer.from(providedSig, "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");
    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      logger.warn({ path: req.path }, "HMAC signature mismatch");
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } });
      return;
    }

    next();
  };
}