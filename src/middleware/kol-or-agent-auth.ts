import { RequestHandler } from "express";
import { createClient } from "@supabase/supabase-js";
import { env, affiliateSupabase } from "../config.js";
import { internalError } from "../utils/controller-error.js";
import { logger } from "../utils/logger.js";

const adminSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Unified identity for routes usable by both KOLs and Agents.
 *
 * The Stripe Connect endpoints (`/me/stripe-connect`, `/me/stripe-status`)
 * are used by both roles — agents also receive commission (via
 * `commission_type='agent_service'`) and need a Connect account to be
 * paid out. We expose a single subject type so the controller can
 * branch on `req.subject.role` without two parallel middlewares.
 */
export interface Subject {
  id: string;
  email: string;
  name: string;
  status: string;
  role: "kol" | "agent";
  country_code: string | null;
}

declare global {
  namespace Express {
    interface Request {
      subject?: Subject;
    }
  }
}

/**
 * Auth middleware accepting either KOL or Agent promoter rows.
 *
 * Differs from kol-auth / agent-auth in that it does NOT filter by
 * role — both 'kol' and 'agent' rows are accepted. Used by routes
 * that are part of both portals (currently just Stripe Connect).
 *
 * Status policy mirrors KolAuth: 'active' and 'pending' both pass.
 * 'pending' Agents are still allowed to onboard Stripe so the admin
 * review doesn't block payout enrollment.
 */
export const kolOrAgentAuthMiddleware: RequestHandler = async (req, res, next) => {
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

  const { data: promoter, error: promoterErr } = await affiliateSupabase.from("promoters")
    .select("id, email, name, status, role, country_code")
    .eq("auth_user_id", user.id)
    .in("role", ["kol", "agent"])
    .maybeSingle();

  if (promoterErr) {
    logger.error({ err: promoterErr }, "kol-or-agent-auth query failed");
    internalError(res, "QUERY_FAILED", promoterErr);
    return;
  }
  if (!promoter) {
    res.status(403).json({
      error: { code: "NOT_A_SUBJECT", message: "No KOL or Agent record for this user" },
    });
    return;
  }
  if (promoter.status && promoter.status !== "active" && promoter.status !== "pending") {
    res.status(403).json({
      error: { code: "SUSPENDED", message: `Account is ${promoter.status}` },
    });
    return;
  }

  req.subject = promoter as Subject;
  next();
};