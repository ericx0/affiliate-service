import { RequestHandler } from "express";
import { createClient } from "@supabase/supabase-js";
import { env, supabase } from "../config.js";
import { internalError } from "../utils/controller-error.js";
import { logger } from "../utils/logger.js";

const adminSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface Agent {
  id: string;
  email: string;
  name: string;
  status: string;
  commission_rate: number;
  stripe_account_id: string | null;
  stripe_onboarding_completed: boolean;
}

declare global {
  namespace Express {
    interface Request {
      agent?: Agent;
    }
  }
}

/**
 * Agent authentication middleware.
 *
 * Mirrors kol-auth but requires the caller's auth_user_id to map to a
 * promoter with role='agent'. Agents are created by admin (not self-
 * registered), so auth_user_id is always populated - no email fallback
 * is needed (unlike kol-auth's legacy path).
 *
 * On success attaches `req.agent` with the agent's promoter row.
 */
export const agentAuthMiddleware: RequestHandler = async (req, res, next) => {
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

  const { data: { user }, error: userErr } = await adminSupabase.auth.getUser(jwt);
  if (userErr || !user || !user.email) {
    res.status(401).json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired JWT" } });
    return;
  }

  const { data: agent, error: agentErr } = await supabase
    .from("affiliate.promoters")
    .select("id, email, name, status, commission_rate, stripe_account_id, stripe_onboarding_completed")
    .eq("auth_user_id", user.id)
    .eq("role", "agent")
    .maybeSingle();

  if (agentErr) {
    logger.error({ err: agentErr }, "agent-auth query failed");
    internalError(res, "QUERY_FAILED", agentErr);
    return;
  }
  if (!agent) {
    res.status(403).json({ error: { code: "NOT_AN_AGENT", message: "No agent record for this user" } });
    return;
  }
  if (agent.status !== "active") {
    res.status(403).json({ error: { code: "SUSPENDED", message: `Agent account is ${agent.status}` } });
    return;
  }

  req.agent = agent as Agent;
  next();
};
