import { RequestHandler, Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { authenticator } from "otplib";
import { env } from "../config.js";

/**
 * Admin JWT + 2FA authentication middleware.
 *
 * Flow:
 * 1. Read `Authorization: Bearer <jwt>` header
 * 2. Verify JWT signature with Supabase (admin client)
 * 3. Look up profile in public.profiles by user.id
 * 4. If profile.is_admin is false → 403
 * 5. If profile.totp_enabled is true → require `X-TOTP-Code` header
 *    and verify against profile.totp_secret
 * 6. On success: attach `req.adminUser = { id, email, isAdmin, totpEnabled }`
 */

const adminSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface AdminUser {
  id: string;
  email: string;
  isAdmin: boolean;
  totpEnabled: boolean;
}

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

/**
 * Verify TOTP code against secret (otplib 12.x compatible).
 */
export function verifyTotp(secret: string, code: string): boolean {
  try {
    return authenticator.check(code, secret);
  } catch {
    return false;
  }
}

/**
 * Generate a new TOTP secret (used during 2FA setup).
 */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/**
 * Get otpauth:// URL for QR code generation in Google Authenticator.
 */
export function getTotpAuthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, "LCM-Affiliate", secret);
}

/**
 * Express middleware: verify Supabase JWT + is_admin flag + (optional) 2FA code.
 */
export const adminAuthMiddleware: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header" } });
    return;
  }

  const jwt = authHeader.slice(7).trim();
  if (!jwt) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Empty JWT" } });
    return;
  }

  // Verify JWT via Supabase
  const { data: { user }, error: userErr } = await adminSupabase.auth.getUser(jwt);
  if (userErr || !user) {
    res.status(401).json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired JWT" } });
    return;
  }

  // Look up profile
  const { data: profile, error: profileErr } = await adminSupabase
    .from("profiles")
    .select("id, email, is_admin, totp_enabled, totp_secret")
    .eq("id", user.id)
    .single();

  if (profileErr || !profile) {
    res.status(403).json({ error: { code: "NOT_ADMIN", message: "Profile not found" } });
    return;
  }

  if (!profile.is_admin) {
    res.status(403).json({ error: { code: "NOT_ADMIN", message: "is_admin=false" } });
    return;
  }

  // If 2FA enabled, require X-TOTP-Code header
  if (profile.totp_enabled) {
    const totpCode = req.headers["x-totp-code"];
    if (!totpCode || typeof totpCode !== "string") {
      res.status(401).json({ error: { code: "TOTP_REQUIRED", message: "X-TOTP-Code header required (2FA enabled)" } });
      return;
    }
    if (!profile.totp_secret || !verifyTotp(profile.totp_secret, totpCode)) {
      res.status(401).json({ error: { code: "TOTP_INVALID", message: "Invalid or expired TOTP code" } });
      return;
    }
  }

  // Attach to request
  req.adminUser = {
    id: profile.id,
    email: profile.email,
    isAdmin: !!profile.is_admin,
    totpEnabled: !!profile.totp_enabled,
  };

  next();
};

/**
 * Role-based authorization. Use AFTER adminAuthMiddleware.
 * (Currently we only have a binary is_admin flag; future enhancement.)
 */
export function requireRole(_roles: string[]) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    next();
  };
}
