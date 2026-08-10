import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";

const QuerySchema = z.object({
  email: z.string().email().max(254),
});

async function verifyTurnstile(token: string, ip: string | undefined): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    logger.error("TURNSTILE_SECRET_KEY not configured");
    return false;
  }
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }).toString(),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    logger.error({ err }, "turnstile siteverify failed");
    return false;
  }
}

/**
 * GET /api/affiliate/auth/check-email?email=...
 * Headers: X-Turnstile-Token (required)
 *
 * Pre-check used by affiliate-portal login page before signInWithOtp.
 * Returns whether the email belongs to an active promoter in
 * `affiliate.promoters` and which role they hold.
 *
 * Anti-enumeration: inactive promoters and missing rows return the
 * SAME `{ exists: false, role: null, registered: false }` shape.
 *
 * Rate limiting: Cloudflare edge (configured in dashboard).
 */
export async function checkEmail(req: Request, res: Response): Promise<void> {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid email" } });
    return;
  }

  const token = req.header("x-turnstile-token");
  if (!token) {
    res.status(403).json({ error: { code: "TURNSTILE_FAILED", message: "Turnstile token required" } });
    return;
  }

  const ip = req.header("cf-connecting-ip") ?? req.ip;
  const turnstileOk = await verifyTurnstile(token, ip);
  if (!turnstileOk) {
    res.status(403).json({ error: { code: "TURNSTILE_FAILED", message: "Turnstile verification failed" } });
    return;
  }

  // Supabase types do not yet include the affiliate.check_email_exists RPC.
  const { data, error } = await supabase.rpc(
    "check_email_exists" as never,
    { p_email: parsed.data.email } as never,
  );

  if (error) {
    logger.error({ err: error, email: parsed.data.email }, "check_email_exists RPC failed");
    res.status(500).json({ error: { code: "CHECK_FAILED", message: "Email check failed" } });
    return;
  }

  const row = Array.isArray(data) ? data[0] : undefined;
  const role = row?.role ?? null;
  const registered = row?.registered === true;
  const exists = role !== null && registered;

  res.status(200).json({ exists, role, registered });
}
