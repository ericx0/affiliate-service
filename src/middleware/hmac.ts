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

    // Replay protection: when a timestamp is provided, it is part of the
    // signed payload and must be within a 5-minute window. Falls back to the
    // legacy body-only scheme when absent (remove this fallback once every
    // caller sends X-LCM-Timestamp).
    const tsHeader = req.headers["x-lcm-timestamp"];
    let signedPayload = rawBody;
    if (typeof tsHeader === "string" && tsHeader) {
      const ts = parseInt(tsHeader, 10);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
        logger.warn({ path: req.path }, "HMAC timestamp outside tolerance");
        res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Stale request" } });
        return;
      }
      signedPayload = `${ts}.${rawBody}`;
    } else {
      logger.warn({ path: req.path }, "X-LCM-Timestamp missing — legacy replay-vulnerable request");
    }
    const expectedSig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

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