import { RequestHandler } from "express";
import { createClient } from "@supabase/supabase-js";
import { env } from "../config.js";
import { supabase } from "../config.js";
import { internalError } from "../utils/controller-error.js";

/**
 * KOL self-service authentication middleware.
 *
 * Flow:
 * 1. Read `Authorization: Bearer <jwt>` header
 * 2. Verify JWT via Supabase (using service-role client)
 * 3. Look up promoter row by email via affiliate_get_promoter_by_email RPC
 * 4. Reject if no promoter row found (user is signed in but isn't a KOL)
 * 5. Reject if promoter.status != 'active'
 * 6. On success: attach `req.promoter = row`
 *
 * Differs from admin-auth.ts in:
 *  - No 2FA requirement (KOL accounts don't have 2FA)
 *  - No role check — any signed-in user with a matching promoter row passes
 *  - Email-only identity (no auth_user_id linkage exists in schema)
 */

const adminSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export interface Promoter {
  id: string;
  email: string;
  name: string;
  status: string;
  country_code: string | null;
  primary_platform: string | null;
  primary_platform_url: string | null;
}

declare global {
  namespace Express {
    interface Request {
      promoter?: Promoter;
      /** Supabase auth user, available after kolAuthMiddleware runs. */
      kolUser?: { id: string; email: string };
    }
  }
}

export const kolAuthMiddleware: RequestHandler = async (req, res, next) => {
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
  if (userErr || !user || !user.email) {
    res.status(401).json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired JWT" } });
    return;
  }

  // AS-P1-8 fix: look up promoter row by auth_user_id (stable) first,
  // fall back to email (legacy — pre-auth_user_id migrations). Once
  // the backfill has run (20260714000032) every active promoter has
  // a populated auth_user_id and the email fallback is only used for
  // any pre-backfill orphan rows.
  const { data: promoterByAuthId } = await supabase
    .from("affiliate.promoters")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  let promoterRows: unknown[] | null = promoterByAuthId
    ? [promoterByAuthId]
    : null;

  if (!promoterRows) {
    const { data: byEmail, error: promoterErr } = await supabase.rpc(
      "affiliate_get_promoter_by_email",
      { p_email: user.email }
    );
    if (promoterErr) {
      // AS-P1-1 fix: never return raw RPC error to client. PostgREST
      // errors can leak table/column names, function signatures, internal
      // UUIDs, or RPC stack traces — useful reconnaissance for an
      // attacker probing the surface. Log internally; return generic.
      logger.error({ err: promoterErr }, "kol-auth RPC failed");
      internalError(res, "QUERY_FAILED", promoterErr);
      return;
    }
    promoterRows = (byEmail as unknown[]) ?? null;
  }

  if (promoterErr) {
    // AS-P1-1 fix: never return raw RPC error to client. PostgREST
    // errors can leak table/column names, function signatures, internal
    // UUIDs, or RPC stack traces — useful reconnaissance for an
    // attacker probing the surface. Log internally; return generic.
    logger.error({ err: promoterErr }, "kol-auth RPC failed");
    internalError(res, "QUERY_FAILED", promoterErr);
    return;
  }

  const promoter = Array.isArray(promoterRows) ? promoterRows[0] : promoterRows;
  if (!promoter) {
    res.status(403).json({
      error: { code: "NOT_A_KOL", message: "No promoter record exists for this user" },
    });
    return;
  }

  if (promoter.status && promoter.status !== "active") {
    res.status(403).json({
      error: { code: "SUSPENDED", message: `Account is ${promoter.status}` },
    });
    return;
  }

  req.promoter = promoter as Promoter;
  req.kolUser = { id: user.id, email: user.email };
  next();
};
