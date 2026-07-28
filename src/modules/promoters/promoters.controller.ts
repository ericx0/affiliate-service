import { Request, Response } from "express";
import { z } from "zod";
import { supabase, affiliateSupabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { internalError } from "../../utils/controller-error.js";
import { notifyAgentWelcome } from "../notifications/notifications.service.js";

const CreatePromoterSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  country_code: z.string().optional(),
  primary_platform: z.string().optional(),
  primary_platform_url: z.string().url().optional(),
  brand_name: z.string().optional(),
  phone: z.string().optional(),
  bio: z.string().optional(),
  role: z.enum(["kol", "agent"]).default("kol"),
  auth_user_id: z.string().uuid().optional(),
  commission_rate: z.number().min(0).max(50).optional(),
});

export async function createPromoter(req: Request, res: Response) {
  const input = CreatePromoterSchema.parse(req.body);

  const { data, error } = await supabase.rpc("affiliate_create_promoter", {
    p_name: input.name,
    p_email: input.email,
    p_country_code: input.country_code || null,
    p_primary_platform: input.primary_platform || null,
    p_primary_platform_url: input.primary_platform_url || null,
    p_brand_name: input.brand_name || null,
    p_phone: input.phone || null,
    p_bio: input.bio || null,
    p_role: input.role,
    p_auth_user_id: input.auth_user_id || null,
    // Agents default to 10% override; KOLs keep the original 5% default.
    p_commission_rate: input.commission_rate ?? (input.role === "agent" ? 10.0 : 5.0),
  });

  if (error) {
    logger.error({ err: error }, "createPromoter failed");
    return internalError(res, "CREATE_FAILED", error);
  }

  logger.info({ promoterId: data?.id, code: data?.code, role: input.role }, "promoter created");
  res.status(201).json(data);
}

const AGENT_RATE_BY_LEVEL: Record<string, number> = {
  basic: 5.0,
  senior: 8.0,
  regional: 10.0,
};

/** Supabase Auth "email already registered" detection (code on newer
 *  SDK versions, message substring on older ones). */
function isEmailExistsError(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "email_exists" || err.code === "user_already_exists") return true;
  return /already (been )?registered|already exists|email_exists/i.test(err.message ?? "");
}

/** supabase-js 2.45 has no admin.getUserByEmail — page listUsers and match. */
async function findAuthUserByEmail(email: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) {
    logger.error({ err: error }, "findAuthUserByEmail: listUsers failed");
    return null;
  }
  const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  return found ? { id: found.id } : null;
}

const CreateAgentSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  agent_level: z.enum(["basic", "senior", "regional"]),
  phone: z.string().optional(),
  brand_name: z.string().optional(),
});

/**
 * Admin creates an agent. Creates the Supabase auth user (service_role -
 * chinamed-admin's anon client cannot) then the promoter row with
 * role='agent' + auth_user_id + agent_level. Commission rate is derived
 * from agent_level (basic 5% / senior 8% / regional 10%).
 *
 * Email-already-registered degradation: if the auth user already exists
 * (e.g. the person was previously a KOL), reuse that auth user instead of
 * failing with 500. If the promoter row also already exists (unique
 * email), return 409 AGENT_EXISTS. On promoter-create failure the auth
 * user is rolled back ONLY if we just created it (never delete a
 * pre-existing account).
 *
 * On success: best-effort welcome email with the agent_invite_code and a
 * "set your own password" recovery link (no plaintext password). Email
 * or link-generation failure never blocks the 201.
 */
export async function createAgent(req: Request, res: Response) {
  const input = CreateAgentSchema.parse(req.body);
  const commissionRate = AGENT_RATE_BY_LEVEL[input.agent_level];

  let authUserId: string;
  let createdAuthUser = false;

  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  if (authErr || !authUser.user) {
    if (isEmailExistsError(authErr)) {
      // Degrade: reuse the existing auth account for this email.
      const existing = await findAuthUserByEmail(input.email);
      if (!existing) {
        logger.error({ err: authErr, email: input.email }, "createAgent: email exists but user lookup failed");
        return internalError(res, "AUTH_USER_CREATE_FAILED", authErr ?? { message: "Failed to create auth user" });
      }
      authUserId = existing.id;
      logger.info({ email: input.email, authUserId }, "createAgent: reusing existing auth user");
    } else {
      logger.error({ err: authErr }, "createAgent: auth user creation failed");
      return internalError(res, "AUTH_USER_CREATE_FAILED", authErr ?? { message: "Failed to create auth user" });
    }
  } else {
    authUserId = authUser.user.id;
    createdAuthUser = true;
  }

  const { data, error } = await supabase.rpc("affiliate_create_promoter", {
    p_name: input.name,
    p_email: input.email,
    p_phone: input.phone || null,
    p_brand_name: input.brand_name || null,
    p_role: "agent",
    p_auth_user_id: authUserId,
    p_commission_rate: commissionRate,
    p_agent_level: input.agent_level,
  });
  if (error) {
    // promoters.email unique violation -> agent already exists.
    if (error.code === "23505" || /duplicate key/i.test(error.message)) {
      // Roll back only the auth user WE just created (restores the prior
      // state); a reused pre-existing account is never deleted.
      if (createdAuthUser) {
        await supabase.auth.admin.deleteUser(authUserId);
      }
      return res.status(409).json({
        error: { code: "AGENT_EXISTS", message: "An agent with this email already exists" },
      });
    }
    if (createdAuthUser) {
      await supabase.auth.admin.deleteUser(authUserId);
    }
    logger.error({ err: error, authUserId }, "createAgent: promoter creation failed; auth user rolled back");
    return internalError(res, "CREATE_FAILED", error);
  }

  // The RPC returns { id, code } (referral code); the agent_invite_code is
  // set by a DB trigger, so read it back from the promoter row.
  let inviteCode = "";
  if (data?.id) {
    const { data: promoterRow, error: rowErr } = await affiliateSupabase
      .from("promoters")
      .select("agent_invite_code")
      .eq("id", data.id)
      .maybeSingle();
    if (rowErr) {
      logger.error({ err: rowErr, promoterId: data.id }, "createAgent: agent_invite_code readback failed");
    } else {
      inviteCode = promoterRow?.agent_invite_code ?? "";
    }
  }

  // Welcome email (best-effort). Generate a recovery "set your own
  // password" link — the email NEVER carries a plaintext password. If
  // link generation fails, send the email anyway without the link (copy
  // falls back to "ask your admin to reset your password").
  let actionLink: string | null = null;
  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email: input.email,
    });
    if (linkErr) {
      logger.error({ err: linkErr, email: input.email }, "createAgent: generateLink failed; welcome email will lack password link");
    } else {
      actionLink = linkData?.properties?.action_link ?? null;
    }
  } catch (e) {
    logger.error({ error: (e as Error).message, email: input.email }, "createAgent: generateLink threw");
  }

  notifyAgentWelcome({
    name: input.name,
    email: input.email,
    inviteCode,
    actionLink,
  }).catch((e) =>
    logger.error({ error: (e as Error).message }, "notifyAgentWelcome failed"),
  );

  logger.info({ agentId: data?.id, authUserId, agentLevel: input.agent_level, reusedAuthUser: !createdAuthUser }, "admin created agent");
  res.status(201).json({ ...(data ?? {}), auth_user_id: authUserId, agent_level: input.agent_level, commission_rate: commissionRate });
}
