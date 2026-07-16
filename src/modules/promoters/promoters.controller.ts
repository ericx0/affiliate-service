import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { internalError } from "../../utils/controller-error.js";

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
 * from agent_level (basic 5% / senior 8% / regional 10%). On promoter-create
 * failure the auth user is rolled back (no orphan login).
 */
export async function createAgent(req: Request, res: Response) {
  const input = CreateAgentSchema.parse(req.body);
  const commissionRate = AGENT_RATE_BY_LEVEL[input.agent_level];

  const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });
  if (authErr || !authUser.user) {
    logger.error({ err: authErr }, "createAgent: auth user creation failed");
    return internalError(res, "AUTH_USER_CREATE_FAILED", authErr ?? { message: "Failed to create auth user" });
  }
  const authUserId = authUser.user.id;

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
    await supabase.auth.admin.deleteUser(authUserId);
    logger.error({ err: error, authUserId }, "createAgent: promoter creation failed; auth user rolled back");
    return internalError(res, "CREATE_FAILED", error);
  }

  logger.info({ agentId: data?.id, authUserId, agentLevel: input.agent_level }, "admin created agent");
  res.status(201).json({ ...(data ?? {}), auth_user_id: authUserId, agent_level: input.agent_level, commission_rate: commissionRate });
}
