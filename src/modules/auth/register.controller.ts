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
  // Optional: agent's referral code (existing agent-binding mechanism, looked
  // up via affiliate.referral_codes). Was required pre-TRD-2026-003; now
  // optional because agent_invite_code is an alternative binding path.
  referralCode: z.string().min(1).max(50).optional(),
  // Optional: agent's invite code (NEW per TRD-2026-003 B3#4). Looked up via
  // affiliate.promoters.agent_invite_code. Accept from body OR ?agent= query
  // (the latter lets /register?agent=CODE work without client-side parsing).
  agent_invite_code: z.string().min(1).max(50).optional(),
  // ESIGN consent: the KOL checked the clickwrap agreeing to the NDA /
  // Affiliate Agreement. Their typed `name` above serves as the
  // electronic signature (recorded in documents.signings).
  consent_confirmed: z.boolean().refine((v) => v === true, {
    message: "consent_confirmed must be true",
  }),
});

/** Extract client IP for e-signature evidence. CF-Connecting-IP first
 *  (Cloudflare), then X-Forwarded-For, then Express req.ip. */
function extractClientIp(req: Request): string | null {
  const cf = req.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? null;
}

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

  // Resolve the active NDA template for the clickwrap consent record
  // (ESIGN Act: the signature must be tied to a specific document
  // version via content_hash). Fail-fast BEFORE creating the promoter
  // so a missing template doesn't leave a promoter without a recorded NDA.
  const { data: ndaTemplate, error: ndaErr } = await supabase
    .schema("documents")
    .from("templates")
    .select("id, content_hash, version")
    .eq("type", "nda")
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ndaErr || !ndaTemplate) {
    logger.error({ err: ndaErr }, "NDA template missing - cannot record clickwrap consent");
    res.status(503).json({
      error: { code: "NDA_TEMPLATE_MISSING", message: "NDA template not configured; cannot record consent. Please contact support." },
    });
    return;
  }

  // Resolve the recruiting agent. Two mechanisms (TRD-2026-003 B3#4):
  //
  //   1. agent_invite_code (preferred) - looked up via
  //      affiliate.promoters.agent_invite_code where role='agent' AND
  //      status='active'. If provided but not found, IGNORE (no error) -
  //      a stale invite link should still let the KOL register.
  //
  //   2. referralCode (fallback) - existing mechanism, looked up via
  //      affiliate.referral_codes. If provided AND invalid -> 400 (the
  //      user typed a code that doesn't match; surface the error so they
  //      can correct it).
  //
  // If neither resolves an agent, register WITHOUT binding
  // (p_recruited_by_agent_id=NULL). The RPC handles null gracefully.
  let recruitedByAgentId: string | null = null;

  // ?agent= query param wins over body.agent_invite_code (TRD writes it as
  // "?agent="; we also accept body.agent_invite_code for clients that prefer
  // to send everything in the body).
  const queryAgent = typeof req.query.agent === "string" ? req.query.agent : null;
  const agentInviteCode = body.agent_invite_code || queryAgent;

  if (agentInviteCode) {
    const { data: agentRow, error: agentLookupErr } = await supabase
      .from("affiliate.promoters")
      .select("id")
      .eq("agent_invite_code", agentInviteCode.toUpperCase())
      .eq("role", "agent")
      .eq("status", "active")
      .maybeSingle();
    if (agentLookupErr) {
      // Log but don't fail - fall through to referralCode / no-binding.
      logger.error({ err: agentLookupErr }, "agent_invite_code lookup failed");
    } else if (agentRow) {
      recruitedByAgentId = agentRow.id;
    }
    // Not found -> ignore (TRD: 找不到 -> 忽略，不报错，正常注册)
  }

  // Fall back to referralCode if agent_invite_code didn't resolve an agent.
  // Keep the existing 400-on-invalid behavior so user-typed invalid codes
  // surface a correction prompt rather than silently unbinding.
  if (!recruitedByAgentId && body.referralCode) {
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
    // Cast via unknown: Supabase types the !inner relation as an array, but
    // referral_codes.promoter_id is a many-to-one FK so maybeSingle() returns
    // a single parent row (not an array). Direct cast errors on the array
    // type; the runtime shape is a single object.
    const refCodeAgent = codeRow.promoters as unknown as { id: string; role: string; status: string } | null;
    if (!refCodeAgent || refCodeAgent.role !== "agent" || refCodeAgent.status !== "active") {
      res.status(400).json({ error: { code: "INVALID_REFERRAL_CODE", message: "Referral code does not belong to an active agent" } });
      return;
    }
    recruitedByAgentId = refCodeAgent.id;
  }

  const { data, error } = await supabase.rpc("affiliate_self_register_promoter", {
    p_auth_user_id: body.authUserId,
    p_name: body.name,
    p_email: body.email,
    p_country: body.countryCode,
    p_platform: body.primaryPlatform,
    p_platform_url: body.primaryPlatformUrl,
    p_recruited_by_agent_id: recruitedByAgentId,
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

  // Record the clickwrap NDA consent in documents.signings (ESIGN Act).
  // The promoter already exists; a failure here is logged loudly but does
  // NOT fail the registration (ops reconciles). signature_text is the typed
  // name (clickwrap signature); signed_content_hash ties to the NDA version.
  const promoterId: string | null = data?.promoter?.id ?? null;
  if (promoterId) {
    const { error: signErr } = await supabase
      .schema("documents")
      .from("signings")
      .insert({
        template_id: ndaTemplate.id,
        signer_email: body.email,
        signer_name: body.name,
        signer_type: "kol",
        promoter_id: promoterId,
        status: "signed",
        signed_at: new Date().toISOString(),
        signed_ip: extractClientIp(req),
        signed_ua: req.get("user-agent") ?? null,
        signature_text: body.name,
        signed_content_hash: ndaTemplate.content_hash,
        invited_by_email: null,
        notes: "clickwrap consent at registration",
      });
    if (signErr) {
      logger.error(
        { err: signErr, promoterId, email: body.email },
        "FAILED to record NDA clickwrap consent in documents.signings",
      );
    }
  } else {
    logger.warn({ email: body.email }, "promoter_id missing from RPC response; NDA consent not recorded");
  }

  res.status(201).json(data);
}
