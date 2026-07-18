import { Request, Response } from "express";
import { z } from "zod";
import { supabase, env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { internalError } from "../../utils/controller-error.js";

const CreateKolSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  country_code: z.string().optional(),
  primary_platform: z.string().optional(),
  primary_platform_url: z.string().url().optional(),
  brand_name: z.string().optional(),
  phone: z.string().optional(),
  bio: z.string().optional(),
  commission_rate: z.number().min(0).max(50).optional(), // defaults to 10.00 in RPC
});

interface CommissionTotal {
  status: string;
  commission_amount: number;
}

function parsePaging(req: Request): { limit: number; offset: number } {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  return { limit, offset };
}

/**
 * POST /api/affiliate/agent/kols - agent creates a KOL bound to themselves.
 *
 * p_agent_promoter_id is server-derived from the JWT (via agent-auth),
 * NEVER client-supplied - prevents binding a KOL to another agent.
 */
export async function createKol(req: Request, res: Response) {
  const agent = req.agent;
  if (!agent) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const input = CreateKolSchema.parse(req.body);

  // Security: KOL commission rate is capped at 10% (fixed, unrelated to the
  // agent's own admin-set rate). The agent's own rate (5/8/10% by level) only
  // affects the agent's override commission, not the KOL cap.
  const MAX_KOL_RATE = 10;
  const kolRate = input.commission_rate ?? MAX_KOL_RATE;
  if (kolRate > MAX_KOL_RATE) {
    res.status(400).json({
      error: { code: "RATE_EXCEEDS_MAX", message: `KOL commission rate cannot exceed ${MAX_KOL_RATE}%` },
    });
    return;
  }

  const { data, error } = await supabase.rpc("affiliate_agent_create_kol", {
    p_agent_promoter_id: agent.id,
    p_name: input.name,
    p_email: input.email,
    p_country_code: input.country_code || null,
    p_primary_platform: input.primary_platform || null,
    p_primary_platform_url: input.primary_platform_url || null,
    p_brand_name: input.brand_name || null,
    p_phone: input.phone || null,
    p_bio: input.bio || null,
    p_commission_rate: kolRate,
  });
  if (error) {
    logger.error({ err: error }, "agent createKol failed");
    internalError(res, "CREATE_FAILED", error);
    return;
  }
  logger.info({ kolId: data?.id, agentId: agent.id }, "agent created KOL");
  res.status(201).json(data);
}

/** GET /api/affiliate/agent/kols - list KOLs this agent recruited (paginated). */
export async function listKols(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const { limit, offset } = parsePaging(req);

  const { data, error, count } = await supabase
    .from("affiliate.promoters")
    .select(
      "id, name, email, status, commission_rate, primary_platform, created_at, total_commission_earned, total_commission_paid",
      { count: "exact" },
    )
    .eq("recruited_by_agent_id", agentId)
    .eq("role", "kol")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [], total: count ?? 0 });
}

/** GET /api/affiliate/agent/kols/:id - KOL detail (ownership enforced). */
export async function getKol(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const { data, error } = await supabase
    .from("affiliate.promoters")
    .select("*")
    .eq("id", req.params.id)
    .eq("role", "kol")
    .eq("recruited_by_agent_id", agentId) // ownership: only own KOLs
    .maybeSingle();
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "KOL not found or not recruited by you" } });
    return;
  }
  res.json({ data });
}

/** GET /api/affiliate/agent/commissions - the agent's own override commissions. */
export async function getMyCommissions(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const { limit, offset } = parsePaging(req);

  const { data, error, count } = await supabase
    .from("affiliate.commissions")
    .select(
      "id, order_id, commission_type, order_amount, commission_rate, commission_amount, currency, status, created_at, paid_at",
      { count: "exact" },
    )
    .eq("promoter_id", agentId)
    .in("commission_type", ["agent_service", "agent_subscription"])
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [], total: count ?? 0 });
}

/**
 * GET /api/affiliate/agent/invite-code - the agent's own invite code + link.
 *
 * Returns the agent's agent_invite_code (auto-populated by the
 * affiliate.auto_set_agent_invite_code trigger) and the KOL registration
 * link with ?agent=<code> query param.
 *
 * Auth: agentAuthMiddleware already enforces role='agent' AND status='active',
 * so KOL JWTs are rejected at the middleware layer (403 NOT_AN_AGENT) - they
 * never reach this handler. Per TRD B6: "KOL 调用返 403 (仅 agent)".
 */
export async function getMyInviteCode(req: Request, res: Response) {
  const agent = req.agent;
  if (!agent) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }

  const { data, error } = await supabase
    .from("affiliate.promoters")
    .select("agent_invite_code")
    .eq("id", agent.id)
    .eq("role", "agent")
    .maybeSingle();
  if (error) return internalError(res, "QUERY_FAILED", error);
  if (!data?.agent_invite_code) {
    // Should not happen: the trigger populates this on INSERT/UPDATE for
    // role='agent'. If we hit this, the trigger is missing or was disabled.
    return internalError(
      res,
      "INVITE_CODE_MISSING",
      new Error(`Agent ${agent.id} has no agent_invite_code (trigger missing?)`),
    );
  }

  const code = data.agent_invite_code;
  const baseUrl = env.PORTAL_URL || env.WEB_URL || "https://affiliate.linkchinamed.com";
  res.json({
    agent_invite_code: code,
    invite_link: `${baseUrl}/register?agent=${code}`,
  });
}

/** GET /api/affiliate/agent/stats - dashboard overview. */
export async function getMyStats(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }

  const { count: totalKols } = await supabase
    .from("affiliate.promoters")
    .select("id", { count: "exact", head: true })
    .eq("recruited_by_agent_id", agentId)
    .eq("role", "kol");
  const { count: activeKols } = await supabase
    .from("affiliate.promoters")
    .select("id", { count: "exact", head: true })
    .eq("recruited_by_agent_id", agentId)
    .eq("role", "kol")
    .eq("status", "active");

  const { data: totals, error: totalsErr } = await supabase
    .from("affiliate.commissions")
    .select("status, commission_amount")
    .eq("promoter_id", agentId)
    .in("commission_type", ["agent_service", "agent_subscription"]);
  if (totalsErr) {
    internalError(res, "QUERY_FAILED", totalsErr);
    return;
  }

  const rows = (totals ?? []) as unknown as CommissionTotal[];
  const sum = (status: string) =>
    rows.filter((r) => r.status === status).reduce((s, r) => s + Number(r.commission_amount), 0);

  res.json({
    totalKols: totalKols ?? 0,
    activeKols: activeKols ?? 0,
    totalPaid: sum("paid"),
    totalPending: sum("cooling_down") + sum("pending"),
    totalApproved: sum("approved"),
    agentRate: req.agent?.commission_rate ?? 0,
  });
}

/** GET /api/affiliate/agent/kols/:id/commissions - a recruited KOL's
 * commission history (service/subscription). Ownership: KOL must be
 * recruited by this agent. */
export async function getKolCommissions(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const { data: kol } = await supabase
    .from("affiliate.promoters")
    .select("id")
    .eq("id", req.params.id)
    .eq("role", "kol")
    .eq("recruited_by_agent_id", agentId)
    .maybeSingle();
  if (!kol) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "KOL not found or not recruited by you" } });
    return;
  }
  const { limit, offset } = parsePaging(req);
  const { data, error, count } = await supabase
    .from("affiliate.commissions")
    .select(
      "id, order_id, commission_type, order_amount, commission_rate, commission_amount, currency, status, created_at, paid_at",
      { count: "exact" },
    )
    .eq("promoter_id", req.params.id)
    .in("commission_type", ["service", "subscription"])
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    internalError(res, "QUERY_FAILED", error);
    return;
  }
  res.json({ data: data ?? [], total: count ?? 0 });
}

/** POST /api/affiliate/agent/kols/:id/suspend - agent suspends a KOL they
 * recruited (ownership-restricted UPDATE). */
export async function suspendKol(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const reason = (req.body?.reason as string) || "Suspended by agent";
  const { data, error } = await supabase
    .from("affiliate.promoters")
    .update({
      status: "suspended",
      suspended_reason: reason,
      suspended_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("role", "kol")
    .eq("recruited_by_agent_id", agentId)
    .select("id, status")
    .maybeSingle();
  if (error) {
    internalError(res, "UPDATE_FAILED", error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "KOL not found or not recruited by you" } });
    return;
  }
  res.json({ success: true, promoter: data });
}

/** POST /api/affiliate/agent/kols/:id/activate - agent reactivates a KOL. */
export async function activateKol(req: Request, res: Response) {
  const agentId = req.agent?.id;
  if (!agentId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const { data, error } = await supabase
    .from("affiliate.promoters")
    .update({
      status: "active",
      suspended_reason: null,
      suspended_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("role", "kol")
    .eq("recruited_by_agent_id", agentId)
    .select("id, status")
    .maybeSingle();
  if (error) {
    internalError(res, "UPDATE_FAILED", error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "KOL not found or not recruited by you" } });
    return;
  }
  res.json({ success: true, promoter: data });
}

const UpdateKolSchema = z.object({
  commission_rate: z.number().min(0).max(50).optional(),
  primary_platform: z.string().optional(),
  primary_platform_url: z.string().url().optional(),
  brand_name: z.string().optional(),
  bio: z.string().optional(),
});

/** PATCH /api/affiliate/agent/kols/:id - agent updates a recruited KOL's
 * editable fields (commission rate, platform, brand, bio). Ownership-restricted. */
export async function updateKol(req: Request, res: Response) {
  const agent = req.agent;
  if (!agent) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing agent context" } });
    return;
  }
  const input = UpdateKolSchema.parse(req.body);

  // Security: KOL commission rate capped at 10% (fixed, unrelated to agent's own rate).
  const MAX_KOL_RATE = 10;
  if (input.commission_rate !== undefined && input.commission_rate > MAX_KOL_RATE) {
    res.status(400).json({
      error: { code: "RATE_EXCEEDS_MAX", message: `KOL commission rate cannot exceed ${MAX_KOL_RATE}%` },
    });
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) updates[k] = v;
  }
  const { data, error } = await supabase
    .from("affiliate.promoters")
    .update(updates)
    .eq("id", req.params.id)
    .eq("role", "kol")
    .eq("recruited_by_agent_id", agent.id)
    .select("id, commission_rate, primary_platform, brand_name, status")
    .maybeSingle();
  if (error) {
    internalError(res, "UPDATE_FAILED", error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "KOL not found or not recruited by you" } });
    return;
  }
  res.json({ success: true, promoter: data });
}
