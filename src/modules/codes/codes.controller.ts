import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase, env } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { generateQrPngBuffer } from "./qr.service.js";

const ParamsSchema = z.object({
  codeId: z.string().uuid(),
});

/**
 * GET /me/codes/:codeId/qr — stream a PNG QR that encodes the public
 * landing URL for the given referral code. The QR is generated on the
 * fly (no caching layer yet) so changes to WEB_URL or the code string
 * propagate immediately. Add future caching by writing the same
 * buffer to the `affiliate-qr-codes` bucket under
 * `{auth_uid}/qr-{code_id}.png` before returning.
 */
export async function getCodeQr(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }

  const parsed = ParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "codeId must be a uuid" } });
    return;
  }
  const { codeId } = parsed.data;

  const { data, error } = await affiliateSupabase
    .from("referral_codes")
    .select("code")
    .eq("id", codeId)
    .eq("promoter_id", promoterId)
    .maybeSingle();
  if (error) {
    internalError(res, "QUERY_FAILED", error, { stage: "lookup" });
    return;
  }
  if (!data?.code) {
    res.status(404).json({ error: { code: "CODE_NOT_FOUND", message: "Referral code not found" } });
    return;
  }

  const landingUrl = `${env.WEB_URL}/?ref=${data.code}`;
  let buffer: Buffer;
  try {
    buffer = await generateQrPngBuffer(landingUrl);
  } catch (err) {
    internalError(res, "QR_GENERATION_FAILED", err, { stage: "render" });
    return;
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(buffer);
}