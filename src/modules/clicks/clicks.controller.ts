import { Request, Response } from "express";
import { z } from "zod";

import { logger } from "../../utils/logger.js";

import { trackClick } from "./clicks.service.js";

const ClickSourceSchema = z.enum(["link", "coupon", "qr"]);

const TrackBodySchema = z.object({
  code: z.string().min(4).max(32).optional(),
  referralCode: z.string().min(4).max(32).optional(),
  source: ClickSourceSchema.default("link"),
  landingPath: z.string().max(500).optional(),
  referrer: z.string().max(1000).optional(),
  utmSource: z.string().max(100).optional(),
  utmMedium: z.string().max(100).optional(),
  utmCampaign: z.string().max(100).optional(),
  utmTerm: z.string().max(100).optional(),
  utmContent: z.string().max(100).optional(),
}).refine((body) => body.code || body.referralCode, {
  message: "code or referralCode is required",
});

/**
 * Public click tracking endpoint. Unknown sources are rejected, while other
 * malformed or unknown referral bodies answer 204 to avoid code enumeration.
 */
export async function track(req: Request, res: Response) {
  const rawSource = (req.body as { source?: unknown } | undefined)?.source;
  if (rawSource !== undefined && !ClickSourceSchema.safeParse(rawSource).success) {
    logger.info("click track: invalid source");
    return res.status(400).end();
  }

  const parsed = TrackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    logger.info({ issues: parsed.error.issues.length }, "click track: malformed body");
    return res.status(204).end();
  }
  const body = parsed.data;
  const referralCode = body.referralCode ?? body.code!;

  try {
    const result = await trackClick({
      referralCode,
      source: body.source,
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
      logger.info({ code: referralCode, reason: result.reason }, "click not recorded");
    }
  } catch (err) {
    logger.error({ err, code: referralCode }, "click track failed");
  }

  return res.status(204).end();
}
