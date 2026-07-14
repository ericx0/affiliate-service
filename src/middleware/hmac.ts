import { RequestHandler } from "express";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { supabase } from "../config.js";

/**
 * HMAC middleware for main-site → affiliate-service webhook calls.
 *
 * Required headers:
 *   X-LCM-Signature: sha256=<hex>           (HMAC-SHA256 hex digest)
 *   X-LCM-Timestamp: <unix-seconds>         (must be within ±5 min)
 *   X-LCM-Nonce: <32+ hex chars>            (must be unique within window)
 *
 * Signed payload: `${timestamp}.${nonce}.${rawBody}`
 *
 * Defence in depth:
 *   - Constant-time signature compare (timingSafeEqual)
 *   - Hard-reject if timestamp missing (no legacy body-only fallback)
 *   - Nonce dedup via Supabase hmac_nonces table (works across
 *     Vercel serverless instances; in-memory would not).
 */
export function hmacMiddleware(
  secret: string = process.env.LCM_AFFILIATE_SECRET || ""
): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!secret) {
        logger.error("LCM_AFFILIATE_SECRET not set");
        res.status(500).json({
          error: { code: "INTERNAL_ERROR", message: "HMAC secret not configured" },
        });
        return;
      }

      // 1. Signature header
      const sigHeader = req.headers["x-lcm-signature"];
      if (!sigHeader || typeof sigHeader !== "string" || !sigHeader.startsWith("sha256=")) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Missing or invalid signature" },
        });
        return;
      }
      const providedSig = sigHeader.slice(7);

      // 2. Timestamp header (REQUIRED — no legacy fallback).
      const tsHeader = req.headers["x-lcm-timestamp"];
      if (typeof tsHeader !== "string" || !tsHeader) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Missing X-LCM-Timestamp" },
        });
        return;
      }
      const ts = parseInt(tsHeader, 10);
      if (!Number.isFinite(ts)) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Invalid X-LCM-Timestamp" },
        });
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - ts) > 300) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Stale request" },
        });
        return;
      }

      // 3. Nonce header (REQUIRED).
      const nonceHeader = req.headers["x-lcm-nonce"];
      if (typeof nonceHeader !== "string" || !nonceHeader || nonceHeader.length < 32 || nonceHeader.length > 128) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Missing or invalid X-LCM-Nonce" },
        });
        return;
      }
      // Validate nonce charset: hex or base64url-ish (alphanumeric + -_).
      if (!/^[A-Za-z0-9_-]+$/.test(nonceHeader)) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Invalid X-LCM-Nonce characters" },
        });
        return;
      }

      // 4. Build signed payload and verify signature (constant-time).
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      const signedPayload = `${ts}.${nonceHeader}.${rawBody}`;
      const expectedSig = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

      const providedBuf = Buffer.from(providedSig, "hex");
      const expectedBuf = Buffer.from(expectedSig, "hex");
      if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
        res.status(401).json({
          error: { code: "UNAUTHORIZED", message: "Invalid signature" },
        });
        return;
      }

      // 5. Nonce dedup — atomically claim the nonce. Conflict = replay.
      const nonceHash = crypto.createHash("sha256").update(nonceHeader).digest("hex");
      const expiresAt = new Date((ts + 300) * 1000).toISOString(); // expires at end of timestamp window

      const { error: nonceErr } = await supabase
        .from("hmac_nonces")
        .insert({ nonce_hash: nonceHash, expires_at: expiresAt });

      if (nonceErr) {
        // 23505 unique_violation = replay; everything else is a server error.
        if (nonceErr.code === "23505") {
          logger.warn({ path: req.path }, "HMAC nonce replay detected");
          res.status(401).json({
            error: { code: "UNAUTHORIZED", message: "Nonce already used" },
          });
          return;
        }
        logger.error({ err: nonceErr, path: req.path }, "HMAC nonce store error");
        res.status(500).json({
          error: { code: "INTERNAL_ERROR", message: "Could not verify nonce" },
        });
        return;
      }

      next();
    } catch (err) {
      logger.error({ err, path: req.path }, "HMAC middleware unhandled error");
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "HMAC verification failed" },
      });
    }
  };
}