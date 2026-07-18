import { Request, Response } from "express";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";

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
  const { data: agents, error: agentsErr } = await supabase
    .from("affiliate.promoters")
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
  const { data: kols, error: kolsErr } = await supabase
    .from("affiliate.promoters")
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
    const { data: kolComms, error: kolCommsErr } = await supabase
      .from("affiliate.commissions")
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
  const { data: agentComms, error: agentCommsErr } = await supabase
    .from("affiliate.commissions")
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
  created_at: string;
}

interface ReferralCodeRow {
  promoter_id: string;
  code: string;
}

/**
 * GET /api/affiliate/admin/agents/:agentId/kols - list KOLs recruited by an agent.
 *
 * Returns the agent's profile (id, name) and the KOLs they recruited
 * with their referral_code, gmv_total (sum of order_amount), and
 * commission_paid (sum of commission_amount where status='paid').
 *
 * Response shape matches TRD B3.
 */
export async function listAgentKols(req: Request, res: Response) {
  const { agentId } = req.params;

  // 1. Verify the agent exists
  const { data: agent, error: agentErr } = await supabase
    .from("affiliate.promoters")
    .select("id, name")
    .eq("id", agentId)
    .eq("role", "agent")
    .maybeSingle();
  if (agentErr) return internalError(res, "QUERY_FAILED", agentErr);
  if (!agent) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Agent not found" } });
    return;
  }

  // 2. Fetch KOLs recruited by this agent
  const { data: kols, error: kolsErr } = await supabase
    .from("affiliate.promoters")
    .select("id, name, email, status, created_at")
    .eq("recruited_by_agent_id", agentId)
    .eq("role", "kol")
    .order("created_at", { ascending: false });
  if (kolsErr) return internalError(res, "QUERY_FAILED", kolsErr);

  const kolList = (kols ?? []) as AgentKolRow[];
  const kolIds = kolList.map((k) => k.id);

  type KolStats = { referral_code: string | null; gmv_total: number; commission_paid: number };
  const kolStats = new Map<string, KolStats>();

  if (kolIds.length > 0) {
    // 3a. Referral codes (one active code per KOL)
    const { data: codes, error: codesErr } = await supabase
      .from("affiliate.referral_codes")
      .select("promoter_id, code")
      .in("promoter_id", kolIds)
      .eq("is_active", true);
    if (codesErr) {
      // Non-fatal: KOLs without a code show referral_code=null
      logger.error({ err: codesErr }, "listAgentKols: referral_codes query failed");
    } else {
      for (const c of (codes ?? []) as ReferralCodeRow[]) {
        const entry = kolStats.get(c.promoter_id) ?? { referral_code: null, gmv_total: 0, commission_paid: 0 };
        // First active code wins (KOLs typically have one code; if multiple,
        // the most recent is fine - we just need a display value).
        if (!entry.referral_code) entry.referral_code = c.code;
        kolStats.set(c.promoter_id, entry);
      }
    }

    // 3b. Commissions (KOL's own, type service/subscription)
    const { data: comms, error: commsErr } = await supabase
      .from("affiliate.commissions")
      .select("promoter_id, status, commission_amount, order_amount")
      .in("promoter_id", kolIds)
      .in("commission_type", ["service", "subscription"]);
    if (commsErr) return internalError(res, "QUERY_FAILED", commsErr);
    for (const c of (comms ?? []) as CommissionRow[]) {
      const entry = kolStats.get(c.promoter_id) ?? { referral_code: null, gmv_total: 0, commission_paid: 0 };
      entry.gmv_total += toNumber(c.order_amount);
      if (c.status === "paid") entry.commission_paid += toNumber(c.commission_amount);
      kolStats.set(c.promoter_id, entry);
    }
  }

  // 4. Build response
  const kolsResponse = kolList.map((k) => {
    const stats = kolStats.get(k.id) ?? { referral_code: null, gmv_total: 0, commission_paid: 0 };
    return {
      id: k.id,
      name: k.name,
      email: k.email,
      status: k.status,
      referral_code: stats.referral_code,
      gmv_total: stats.gmv_total,
      commission_paid: stats.commission_paid,
      recruited_at: k.created_at,
    };
  });

  res.json({
    agent: { id: agent.id, name: agent.name },
    kols: kolsResponse,
  });
}
