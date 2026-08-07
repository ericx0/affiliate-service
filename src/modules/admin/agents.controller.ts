import { Request, Response } from "express";
import { affiliateSupabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";
import { writeAuditLog } from "./audit.service.js";

// BigInt columns (commission_amount, order_amount) come back from Supabase
// as strings to preserve precision. Summing in JS is safe within
// Number.MAX_SAFE_INTEGER for realistic GMV / commission totals.
interface CommissionRow {
  promoter_id: string;
  status: string;
  commission_amount: string | number;
  order_amount?: string | number;
}

interface AgentListRow {
  id: string;
  name: string;
  email: string;
  status: string;
  agent_invite_code: string | null;
  created_at: string;
}

interface KolListRow {
  id: string;
  recruited_by_agent_id: string;
  status: string;
}

function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

// Statuses that count as "pending" (not yet paid out to the agent).
// Mirrors the existing v_promoter_stats / agent getMyStats convention.
const PENDING_STATUSES = ["cooling_down", "pending", "approved"];

/**
 * GET /api/affiliate/admin/agents - list agents with KOL + commission stats.
 *
 * Returns one row per agent (role='agent') with aggregated:
 *   - kol_count:         total KOLs recruited by this agent
 *   - kol_active_count:  KOLs with status='active'
 *   - gmv_total:         sum of order_amount across the agent's KOLs'
 *                         own commissions (service / subscription)
 *   - commission_paid:    agent override commissions already paid
 *                         (commission_type IN agent_service/agent_subscription,
 *                          status='paid')
 *   - commission_pending: agent override commissions not yet paid
 *                         (status IN cooling_down/pending/approved)
 *
 * Amounts are returned in CENTS (matches affiliate_list_promoters and
 * the admin UI convention - frontend renders with toFixed(2), no /100).
 */
export async function listAgents(_req: Request, res: Response) {
  // 1. Fetch all agents (id + profile fields only - aggregations are
  //    fetched separately to avoid the cartesian-product blow-up that
  //    comes from joining KOLs + commissions on the same query).
  const { data: agents, error: agentsErr } = await affiliateSupabase.from("promoters")
    .select("id, name, email, status, agent_invite_code, created_at")
    .eq("role", "agent")
    .order("created_at", { ascending: false });
  if (agentsErr) return internalError(res, "QUERY_FAILED", agentsErr);

  const agentList = (agents ?? []) as AgentListRow[];
  if (agentList.length === 0) {
    res.json({ data: [] });
    return;
  }

  const agentIds = agentList.map((a) => a.id);

  // 2. KOLs recruited by these agents (id + status for count/active breakdown).
  const { data: kols, error: kolsErr } = await affiliateSupabase.from("promoters")
    .select("id, recruited_by_agent_id, status")
    .eq("role", "kol")
    .in("recruited_by_agent_id", agentIds);
  if (kolsErr) return internalError(res, "QUERY_FAILED", kolsErr);

  const kolList = (kols ?? []) as KolListRow[];
  const kolIds = kolList.map((k) => k.id);

  // 3. GMV per KOL: sum order_amount of the KOL's own commissions
  //    (service / subscription). This is the GMV the KOL generated.
  const gmvByKol = new Map<string, number>();
  if (kolIds.length > 0) {
    const { data: kolComms, error: kolCommsErr } = await affiliateSupabase.from("commissions")
      .select("promoter_id, order_amount")
      .in("promoter_id", kolIds)
      .in("commission_type", ["service", "subscription"]);
    if (kolCommsErr) return internalError(res, "QUERY_FAILED", kolCommsErr);
    for (const c of (kolComms ?? []) as CommissionRow[]) {
      gmvByKol.set(
        c.promoter_id,
        (gmvByKol.get(c.promoter_id) ?? 0) + toNumber(c.order_amount),
      );
    }
  }

  // 4. Agent override commissions (agent_service / agent_subscription).
  //    Group by agent, split by paid vs pending.
  const commByAgent = new Map<string, { paid: number; pending: number }>();
  const { data: agentComms, error: agentCommsErr } = await affiliateSupabase.from("commissions")
    .select("promoter_id, status, commission_amount")
    .in("promoter_id", agentIds)
    .in("commission_type", ["agent_service", "agent_subscription"]);
  if (agentCommsErr) return internalError(res, "QUERY_FAILED", agentCommsErr);
  for (const c of (agentComms ?? []) as CommissionRow[]) {
    const entry = commByAgent.get(c.promoter_id) ?? { paid: 0, pending: 0 };
    const amt = toNumber(c.commission_amount);
    if (c.status === "paid") entry.paid += amt;
    else if (PENDING_STATUSES.includes(c.status)) entry.pending += amt;
    commByAgent.set(c.promoter_id, entry);
  }

  // 5. Build response
  const data = agentList.map((a) => {
    const kolsForAgent = kolList.filter((k) => k.recruited_by_agent_id === a.id);
    const gmvTotal = kolsForAgent.reduce(
      (sum, k) => sum + (gmvByKol.get(k.id) ?? 0),
      0,
    );
    const comm = commByAgent.get(a.id) ?? { paid: 0, pending: 0 };
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      status: a.status,
      agent_invite_code: a.agent_invite_code,
      kol_count: kolsForAgent.length,
      kol_active_count: kolsForAgent.filter((k) => k.status === "active").length,
      gmv_total: gmvTotal,
      commission_paid: comm.paid,
      commission_pending: comm.pending,
      created_at: a.created_at,
    };
  });

  res.json({ data });
}

interface AgentKolRow {
  id: string;
  name: string;
  email: string;
  status: string;
  brand_name: string | null;
  primary_platform: string | null;
  commission_rate: number;
  commission_type: string;
  stripe_account_id: string | null;
  stripe_onboarding_completed: boolean | null;
  tax_form_status: string | null;
  created_at: string;
}

interface ReferralCodeRow {
  promoter_id: string;
  code: string;
}

// Commissions come back as strings for bigint columns; normalize to number.
interface KolCommissionRow {
  promoter_id: string;
  status: string;
  commission_amount: string | number;
  order_amount: string | number;
}

/**
 * GET /api/affiliate/admin/agents/:agentId/kols - list KOLs recruited by an agent.
 *
 * Returns the agent's profile plus the KOLs they recruited with:
 *   - referral_code (active code)
 *   - gmv_total (sum of order_amount for service/subscription commissions)
 *   - commission_paid (sum of commission_amount where status='paid')
 *   - commission_pending (sum where status IN cooling_down/pending/approved)
 *   - brand, platform, commission rate, Stripe status, tax-form status
 */
export async function listAgentKols(req: Request, res: Response) {
  const { agentId } = req.params;

  // 1. Verify the agent exists
  const { data: agent, error: agentErr } = await affiliateSupabase.from("promoters")
    .select("id, name, email, status, agent_invite_code, created_at")
    .eq("id", agentId)
    .eq("role", "agent")
    .maybeSingle();
  if (agentErr) return internalError(res, "QUERY_FAILED", agentErr);
  if (!agent) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Agent not found" } });
    return;
  }

  // 2. Fetch KOLs recruited by this agent
  const { data: kols, error: kolsErr } = await affiliateSupabase.from("promoters")
    .select(
      "id, name, email, status, brand_name, primary_platform, commission_rate, commission_type, stripe_account_id, stripe_onboarding_completed, created_at",
    )
    .eq("recruited_by_agent_id", agentId)
    .eq("role", "kol")
    .order("created_at", { ascending: false });
  if (kolsErr) return internalError(res, "QUERY_FAILED", kolsErr);

  const kolList = (kols ?? []) as AgentKolRow[];
  const kolIds = kolList.map((k) => k.id);

  // 2b. Latest tax-form status per KOL (queried separately to avoid schema
  //     relation-hint ambiguity across the affiliate-schema client).
  const taxFormStatusByKol = new Map<string, string | null>();
  if (kolIds.length > 0) {
    const { data: taxForms, error: taxFormsErr } = await affiliateSupabase.from("tax_forms")
      .select("promoter_id, status")
      .in("promoter_id", kolIds)
      .order("submitted_at", { ascending: false });
    if (taxFormsErr) {
      logger.error({ err: taxFormsErr }, "listAgentKols: tax_forms query failed");
    } else {
      for (const tf of taxForms ?? []) {
        if (!taxFormStatusByKol.has(tf.promoter_id)) {
          taxFormStatusByKol.set(tf.promoter_id, tf.status);
        }
      }
    }
  }

  type KolStats = {
    referral_code: string | null;
    gmv_total: number;
    commission_paid: number;
    commission_pending: number;
  };
  const kolStats = new Map<string, KolStats>();

  if (kolIds.length > 0) {
    // 3a. Referral codes (one active code per KOL)
    const { data: codes, error: codesErr } = await affiliateSupabase.from("referral_codes")
      .select("promoter_id, code")
      .in("promoter_id", kolIds)
      .eq("is_active", true);
    if (codesErr) {
      // Non-fatal: KOLs without a code show referral_code=null
      logger.error({ err: codesErr }, "listAgentKols: referral_codes query failed");
    } else {
      for (const c of (codes ?? []) as ReferralCodeRow[]) {
        const entry = kolStats.get(c.promoter_id) ?? {
          referral_code: null,
          gmv_total: 0,
          commission_paid: 0,
          commission_pending: 0,
        };
        // First active code wins (KOLs typically have one code; if multiple,
        // the most recent is fine - we just need a display value).
        if (!entry.referral_code) entry.referral_code = c.code;
        kolStats.set(c.promoter_id, entry);
      }
    }

    // 3b. Commissions (KOL's own, type service/subscription)
    const { data: comms, error: commsErr } = await affiliateSupabase.from("commissions")
      .select("promoter_id, status, commission_amount, order_amount")
      .in("promoter_id", kolIds)
      .in("commission_type", ["service", "subscription"]);
    if (commsErr) return internalError(res, "QUERY_FAILED", commsErr);
    for (const c of (comms ?? []) as KolCommissionRow[]) {
      const entry = kolStats.get(c.promoter_id) ?? {
        referral_code: null,
        gmv_total: 0,
        commission_paid: 0,
        commission_pending: 0,
      };
      entry.gmv_total += toNumber(c.order_amount);
      const commissionAmount = toNumber(c.commission_amount);
      if (c.status === "paid") entry.commission_paid += commissionAmount;
      else if (["cooling_down", "pending", "approved"].includes(c.status)) {
        entry.commission_pending += commissionAmount;
      }
      kolStats.set(c.promoter_id, entry);
    }
  }

  // 4. Build response
  const kolsResponse = kolList.map((k) => {
    const stats = kolStats.get(k.id) ?? {
      referral_code: null,
      gmv_total: 0,
      commission_paid: 0,
      commission_pending: 0,
    };
    return {
      id: k.id,
      name: k.name,
      email: k.email,
      status: k.status,
      brand_name: k.brand_name,
      primary_platform: k.primary_platform,
      commission_rate: k.commission_rate,
      commission_type: k.commission_type,
      referral_code: stats.referral_code,
      gmv_total: stats.gmv_total,
      commission_paid: stats.commission_paid,
      commission_pending: stats.commission_pending,
      stripe_account_id: k.stripe_account_id,
      stripe_onboarding_completed: k.stripe_onboarding_completed,
      tax_form_status: taxFormStatusByKol.get(k.id) ?? null,
      recruited_at: k.created_at,
    };
  });

  res.json({
    agent: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      status: agent.status,
      agent_invite_code: agent.agent_invite_code,
      created_at: agent.created_at,
    },
    kols: kolsResponse,
  });
}

/**
 * DELETE /api/affiliate/admin/agents/:agentId - delete an agent.
 *
 * Safety guard: an agent can only be deleted if they have NO recruited KOLs,
 * NO commissions (of any type), and NO referral clicks. This prevents orphan
 * KOLs and preserves commission / click attribution history.
 *
 * The promoter row is hard-deleted; the Supabase auth user is left intact so
 * login history is preserved. If the agent needs to be fully purged, delete
 * the auth user separately from Supabase Auth dashboard.
 */
export async function deleteAgent(req: Request, res: Response) {
  const { agentId } = req.params;
  const adminUser = (req as any).adminUser as { id?: string; email?: string } | undefined;
  const actorId = adminUser?.id ?? "00000000-0000-0000-0000-000000000000";
  const actorEmail = adminUser?.email ?? "unknown@linkchinamed.com";

  // 1. Verify target is an agent and fetch snapshot for audit log
  const { data: agent, error: agentErr } = await affiliateSupabase.from("promoters")
    .select("id, name, email, status, agent_level, commission_rate")
    .eq("id", agentId)
    .eq("role", "agent")
    .maybeSingle();
  if (agentErr) return internalError(res, "QUERY_FAILED", agentErr);
  if (!agent) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Agent not found" } });
    return;
  }

  // 2. Guard: recruited KOLs
  const { count: kolCount, error: kolErr } = await affiliateSupabase.from("promoters")
    .select("id", { count: "exact", head: true })
    .eq("recruited_by_agent_id", agentId)
    .eq("role", "kol");
  if (kolErr) return internalError(res, "QUERY_FAILED", kolErr);
  if ((kolCount ?? 0) > 0) {
    res.status(400).json({
      error: {
        code: "AGENT_HAS_KOLS",
        message: `该代理旗下还有 ${kolCount} 个 KOL，请先将其 KOL 转移或删除后再删除代理。`,
      },
    });
    return;
  }

  // 3. Guard: commissions (agent override or KOL commissions tied to this promoter)
  const { count: commCount, error: commErr } = await affiliateSupabase.from("commissions")
    .select("id", { count: "exact", head: true })
    .eq("promoter_id", agentId);
  if (commErr) return internalError(res, "QUERY_FAILED", commErr);
  if ((commCount ?? 0) > 0) {
    res.status(400).json({
      error: {
        code: "AGENT_HAS_COMMISSIONS",
        message: "该代理存在佣金记录，无法删除。",
      },
    });
    return;
  }

  // 4. Guard: referral clicks
  const { count: clickCount, error: clickErr } = await affiliateSupabase.from("referral_clicks")
    .select("id", { count: "exact", head: true })
    .eq("promoter_id", agentId);
  if (clickErr) return internalError(res, "QUERY_FAILED", clickErr);
  if ((clickCount ?? 0) > 0) {
    res.status(400).json({
      error: {
        code: "AGENT_HAS_CLICKS",
        message: "该代理存在推广点击记录，无法删除。",
      },
    });
    return;
  }

  // 5. Delete the agent promoter row
  const { error: deleteErr } = await affiliateSupabase.from("promoters")
    .delete()
    .eq("id", agentId)
    .eq("role", "agent");
  if (deleteErr) return internalError(res, "DELETE_FAILED", deleteErr);

  await writeAuditLog({
    actorId,
    actorEmail,
    action: "delete_agent",
    targetType: "agent",
    targetId: agentId,
    beforeState: agent,
    afterState: null,
    reason: "Admin deleted agent from admin-v2",
  });

  res.status(204).send();
}
