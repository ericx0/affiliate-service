import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { trackClick } from "./clicks.service.js";

// Public contract for POST /api/affiliate/clicks/track (called server-side
// by the main-site edge middleware). All fields besides `code` are optional.
const TrackBodySchema = z.object({
  code: z.string().min(4).max(32),
  landingPath: z.string().max(500).optional(),
  referrer: z.string().max(1000).optional(),
  utmSource: z.string().max(100).optional(),
  utmMedium: z.string().max(100).optional(),
  utmCampaign: z.string().max(100).optional(),
  utmTerm: z.string().max(100).optional(),
  utmContent: z.string().max(100).optional(),
});

/**
 * POST /api/affiliate/clicks/track
 *
 * Public endpoint (no HMAC, no JWT). ALWAYS answers 204 — including for
 * invalid/unknown/expired codes and malformed bodies — so the endpoint
 * cannot be used to probe which referral codes exist. Failures are logged
 * server-side only.
 */
export async function track(req: Request, res: Response) {
  const parsed = TrackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    logger.info({ issues: parsed.error.issues.length }, "click track: malformed body");
    return res.status(204).end();
  }
  const body = parsed.data;

  try {
    const result = await trackClick({
      referralCode: body.code,
      // Trust boundary: this endpoint is public, so the client IP/UA are
      // taken from the request, never from the caller-controlled body.
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
      landingPath: body.landingPath,
      referrer: body.referrer,
      utmSource: body.utmSource,
      utmMedium: body.utmMedium,
      utmCampaign: body.utmCampaign,
      utmTerm: body.utmTerm,
      utmContent: body.utmContent,
    });
    if (!result.recorded) {
      logger.info({ code: body.code, reason: result.reason }, "click not recorded");
    }
  } catch (err) {
    // Never surface tracking failures to the caller — the landing page
    // flow must not be affected by analytics.
    logger.error({ err, code: body.code }, "click track failed");
  }

  return res.status(204).end();
}
