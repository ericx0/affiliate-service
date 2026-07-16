import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";

const SelfRegisterSchema = z.object({
  authUserId: z.string().uuid("Invalid authUserId"),
  name: z.string().min(1).max(100),
  email: z.string().email().max(254),
  countryCode: z.string().min(2).max(8),
  primaryPlatform: z.string().min(1).max(50),
  primaryPlatformUrl: z.string().url().max(500),
  referralCode: z.string().min(1).max(50),
});

/**
 * POST /api/affiliate/auth/register
 *
 * KOL self-registration (separate from the admin-authenticated
 * /api/affiliate/promoters endpoint, which is used by chinamed-admin).
 *
 * Security:
 *  - Requires a valid Supabase session JWT (via kolAuthMiddleware)
 *  - Verifies the body's `email` matches the verified user's email
 *    to prevent an attacker from creating phantom promoter rows
 *    for arbitrary emails.
 *  - Per-email rate limit (AS-P2-8): 5 attempts per email per hour
 *    via the rate_limit_consume RPC. Single-IP NAT bypasses the
 *    IP-based limit in index.ts; this second layer keys on email.
 *  - Returns 409 on duplicate email (SQLSTATE 23505 from the RPC).
 */
export async function selfRegister(req: Request, res: Response) {
  const user = req.kolUser;
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing auth context" } });
    return;
  }

  // AS-P2-8: per-email rate limit. 5 attempts per email per hour.
  // Runs BEFORE Zod parsing so a malformed-body spam attack also
  // counts against the limit.
  const emailForLimit = (req.body as { email?: string } | undefined)?.email?.toLowerCase() ?? user.email;
  if (emailForLimit) {
    const { data: rlData, error: rlErr } = await supabase.rpc(
      "rate_limit_consume" as never,
      {
        p_key: `kol-register:${emailForLimit}`,
        p_limit: 5,
        p_window_seconds: 3600,
      } as never,
    );
    if (rlErr) {
      logger.error({ err: rlErr }, "kol-register rate limit RPC failed");
    } else if (Array.isArray(rlData) && rlData[0]?.allowed === false) {
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many registration attempts for this email. Try again later.",
        },
      });
      return;
    }
  }

  const parsed = SelfRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }
  const body = parsed.data;

  // Critical: body.email MUST match the verified user's email.
  if (body.email.toLowerCase() !== user.email.toLowerCase()) {
    res.status(403).json({
      error: { code: "EMAIL_MISMATCH", message: "body.email does not match the authenticated user" },
    });
    return;
  }

  // Critical: body.authUserId MUST be the caller's own id — otherwise a
  // caller could link a promoter row to a different auth user's id.
  if (body.authUserId !== user.id) {
    res.status(403).json({
      error: { code: "USER_MISMATCH", message: "authUserId does not match the authenticated user" },
    });
    return;
  }

  // Look up the recruiting agent by referral code (must be an active agent).
  const { data: codeRow, error: codeErr } = await supabase
    .from("affiliate.referral_codes")
    .select("promoter_id, promoters!inner(id, role, status)")
    .eq("code", body.referralCode.toUpperCase())
    .eq("is_active", true)
    .maybeSingle();
  if (codeErr || !codeRow) {
    res.status(400).json({ error: { code: "INVALID_REFERRAL_CODE", message: "Invalid or inactive referral code" } });
    return;
  }
  const agent = codeRow.promoters as { id: string; role: string; status: string } | null;
  if (!agent || agent.role !== "agent" || agent.status !== "active") {
    res.status(400).json({ error: { code: "INVALID_REFERRAL_CODE", message: "Referral code does not belong to an active agent" } });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_self_register_promoter", {
    p_auth_user_id: body.authUserId,
    p_name: body.name,
    p_email: body.email,
    p_country: body.countryCode,
    p_platform: body.primaryPlatform,
    p_platform_url: body.primaryPlatformUrl,
    p_recruited_by_agent_id: agent.id,
  });

  if (error) {
    // PostgreSQL unique_violation
    if (error.code === "23505" || /duplicate key/i.test(error.message)) {
      res.status(409).json({
        error: { code: "ALREADY_REGISTERED", message: "A promoter record already exists for this email" },
      });
      return;
    }
    internalError(res, "REGISTER_FAILED", error);
    return;
  }

  res.status(201).json(data);
}
