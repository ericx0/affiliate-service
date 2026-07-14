import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { generateTotpSecret, getTotpAuthUrl, verifyTotp } from "../../middleware/admin-auth.js";
import { writeAuditLog } from "../admin/audit.service.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * Admin 2FA setup endpoints.
 * Separate route prefix (/api/affiliate/auth/admin/*).
 * No HMAC required (only Supabase JWT).
 */

export async function setupTotp(req: Request, res: Response) {
  const user = (req as any).adminUser;
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    return;
  }

  // Generate new secret
  const secret = generateTotpSecret();
  const otpauthUrl = getTotpAuthUrl(user.email, secret);

  // Save secret (but not yet enabled — requires verify step)
  const { error } = await supabase
    .from("profiles")
    .update({ totp_secret: secret, totp_enabled: false })
    .eq("id", user.id);

  if (error) {
    logger.error({ err: error }, "setupTotp failed");
    internalError(res, "SETUP_FAILED", error);
    return;
  }

  await writeAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    action: "totp_setup",
    targetType: "admin",
    targetId: user.id,
    reason: "User initiated TOTP setup",
  });

  // AS-P1-7 fix: do NOT return the raw TOTP secret in the response.
  // Anyone intercepting the response (browser extension, XSS,
  // compromised CDN, MITM if TLS downgrades) would have full
  // 2FA bypass. The otpauth_url is sufficient for the standard
  // QR-code enrollment flow; users who need manual entry can extract
  // the secret from the otpauth:// URL locally on their own device.
  res.json({
    otpauth_url: otpauthUrl,
    instructions: "Scan the otpauth_url QR with Google Authenticator, then call POST /auth/admin/2fa/verify with the 6-digit code to enable.",
  });
}

const VerifyTotpSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});

export async function verifyTotpSetup(req: Request, res: Response) {
  const user = (req as any).adminUser;
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    return;
  }

  const { code } = VerifyTotpSchema.parse(req.body);

  // Get current secret (must exist from setup)
  const { data: profile } = await supabase
    .from("profiles")
    .select("totp_secret")
    .eq("id", user.id)
    .single();

  if (!profile?.totp_secret) {
    res.status(400).json({ error: { code: "NO_SETUP", message: "Call /2fa/setup first" } });
    return;
  }

  if (!verifyTotp(profile.totp_secret, code)) {
    res.status(400).json({ error: { code: "INVALID_CODE", message: "TOTP code invalid" } });
    return;
  }

  // Enable 2FA
  const { error } = await supabase
    .from("profiles")
    .update({ totp_enabled: true, totp_verified_at: new Date().toISOString() })
    .eq("id", user.id);

  if (error) {
    internalError(res, "ENABLE_FAILED", error);
    return;
  }

  await writeAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    action: "totp_enabled",
    targetType: "admin",
    targetId: user.id,
    reason: "User verified and enabled 2FA",
  });

  res.json({ success: true, message: "2FA enabled. All future admin API calls require X-TOTP-Code header." });
}

export async function disableTotp(req: Request, res: Response) {
  const user = (req as any).adminUser;
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    return;
  }

  // Require a valid current TOTP code to disable 2FA. This route is behind
  // JWT only (not the per-request TOTP check), so without this a stolen JWT
  // could switch 2FA off.
  const code =
    (req.headers["x-totp-code"] as string) || (req.body?.code as string) || "";
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({
      error: {
        code: "TOTP_REQUIRED",
        message: "A valid 6-digit TOTP code is required to disable 2FA",
      },
    });
    return;
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("totp_secret, totp_enabled")
    .eq("id", user.id)
    .single();
  if (
    !profile?.totp_enabled ||
    !profile.totp_secret ||
    !verifyTotp(profile.totp_secret, code)
  ) {
    res.status(401).json({
      error: { code: "INVALID_TOTP", message: "Invalid TOTP code" },
    });
    return;
  }

  const { error } = await supabase
    .from("profiles")
    .update({ totp_secret: null, totp_enabled: false })
    .eq("id", user.id);

  if (error) {
    internalError(res, "DISABLE_FAILED", error);
    return;
  }

  await writeAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    action: "totp_disabled",
    targetType: "admin",
    targetId: user.id,
    reason: "User disabled 2FA",
  });

  res.json({ success: true, message: "2FA disabled" });
}

export async function getTotpStatus(req: Request, res: Response) {
  const user = (req as any).adminUser;
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    return;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("totp_enabled, totp_verified_at")
    .eq("id", user.id)
    .single();

  res.json({
    totp_enabled: !!profile?.totp_enabled,
    totp_verified_at: profile?.totp_verified_at || null,
  });
}
