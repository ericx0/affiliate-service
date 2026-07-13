import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

const SelfRegisterSchema = z.object({
  authUserId: z.string().uuid("Invalid authUserId"),
  name: z.string().min(1).max(100),
  email: z.string().email().max(254),
  countryCode: z.string().min(2).max(8),
  primaryPlatform: z.string().min(1).max(50),
  primaryPlatformUrl: z.string().url().max(500),
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
 *  - Returns 409 on duplicate email (SQLSTATE 23505 from the RPC).
 */
export async function selfRegister(req: Request, res: Response) {
  const user = req.kolUser;
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing auth context" } });
    return;
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

  const { data, error } = await supabase.rpc("affiliate_self_register_promoter", {
    p_auth_user_id: body.authUserId,
    p_name: body.name,
    p_email: body.email,
    p_country: body.countryCode,
    p_platform: body.primaryPlatform,
    p_platform_url: body.primaryPlatformUrl,
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
