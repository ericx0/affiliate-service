import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";

const SyncSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  countryCode: z.string().min(2).max(8).optional(),
  primaryPlatform: z.string().min(1).max(50).optional(),
  primaryPlatformUrl: z.string().url().max(500).optional(),
}).strict();

/**
 * POST /api/affiliate/auth/sync
 *
 * Called by iOS / web client on every successful signin (and on
 * app foreground). Keeps the local promoter row's email + profile
 * fields in sync with the verified Supabase JWT email.
 *
 * Why this exists:
 *   - Promoter rows are matched on auth_user_id (AS-P1-8 fix).
 *   - But the email stored in `affiliate.promoters.email` is a
 *     separate snapshot. If a KOL changes their Supabase auth
 *     email, the old email stays in the promoter row and would
 *     create an inconsistency in admin/ops tooling.
 *   - This endpoint idempotently updates the promoter row to
 *     match the verified JWT identity.
 *
 * Idempotency: re-call with same body = no-op (only writes when
 * something changed).
 *
 * Security: requires kolAuthMiddleware (validates JWT + looks up
 * promoter by auth_user_id). The body's name / country / platform
 * fields are optional — if omitted, only email is synced.
 */
export async function syncKOLProfile(req: Request, res: Response) {
  const user = req.kolUser;
  const promoter = req.promoter;
  if (!user || !promoter) {
    res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing auth context" },
    });
    return;
  }

  // The verified email is the source of truth.
  const verifiedEmail = user.email;
  if (!verifiedEmail) {
    res.status(401).json({
      error: { code: "NO_EMAIL", message: "JWT has no email claim" },
    });
    return;
  }

  const parsed = SyncSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() },
    });
    return;
  }

  // Compute diff — only update fields that actually changed.
  const updates: Record<string, unknown> = {};
  if (promoter.email !== verifiedEmail) updates.email = verifiedEmail;
  if (parsed.data.name && parsed.data.name !== promoter.name) {
    updates.name = parsed.data.name;
  }
  if (
    parsed.data.countryCode &&
    parsed.data.countryCode !== promoter.country_code
  ) {
    updates.country_code = parsed.data.countryCode;
  }
  if (
    parsed.data.primaryPlatform &&
    parsed.data.primaryPlatform !== promoter.primary_platform
  ) {
    updates.primary_platform = parsed.data.primaryPlatform;
  }
  if (
    parsed.data.primaryPlatformUrl &&
    parsed.data.primaryPlatformUrl !== promoter.primary_platform_url
  ) {
    updates.primary_platform_url = parsed.data.primaryPlatformUrl;
  }

  if (Object.keys(updates).length === 0) {
    res.json({ success: true, changed: false });
    return;
  }

  const { error } = await supabase
    .from("affiliate.promoters")
    .update(updates)
    .eq("auth_user_id", user.id);

  if (error) {
    logger.error({ err: error, userId: user.id }, "KOL sync failed");
    res.status(500).json({
      error: { code: "SYNC_FAILED", message: "Failed to sync profile" },
    });
    return;
  }

  logger.info(
    { userId: user.id, changedFields: Object.keys(updates) },
    "KOL profile synced"
  );
  res.json({ success: true, changed: true, fields: Object.keys(updates) });
}