import { RequestHandler } from "express";
import { createClient } from "@supabase/supabase-js";
import { env } from "../config.js";
import { supabase, affiliateSupabase } from "../config.js";
import { internalError } from "../utils/controller-error.js";
import { logger } from "../utils/logger.js";

/**
 * KOL self-service authentication middleware.
 *
 * Flow:
 * 1. Read `Authorization: Bearer <jwt>` header
 * 2. Verify JWT via Supabase (using service-role client)
 * 3. Look up promoter row by email via affiliate_get_promoter_by_email RPC
 * 4. Reject if no promoter row found (user is signed in but isn't a KOL)
 * 5. Reject if promoter.status is neither 'active' nor 'pending'.
 *    'pending' (self-registered, awaiting admin review) MAY log in and
 *    use the portal (tax form, Stripe Connect onboarding, dashboard),
 *    but cannot create referral codes (enforced in createMyCode) and
 *    earns no commission (order attach rejects non-active promoters).
 * 6. On success: attach `req.promoter = row`
 *
 * Differs from admin-auth.ts in:
 *  - No 2FA requirement (KOL accounts don't have 2FA)
 *  - Role check: rejects role='agent' promoters (see test 'rejects an agent')
 *  - Email-only identity (no auth_user_id linkage exists in schema)
 */

const adminSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// In-process auth cache (30-second TTL).
//
// The dashboard fires 6 parallel API requests on every load. Each would
// normally trigger:
//   1. adminSupabase.auth.getUser(jwt)   — Supabase Auth network round-trip
//   2. promoters table lookup             — Supabase DB network round-trip
//
// With the cache all requests that share the same JWT within the TTL window
// are served from memory (< 1 ms) after the first resolution.
// ---------------------------------------------------------------------------
interface CacheEntry {
  kolUser: { id: string; email: string };
  promoter: Promoter;
  expiresAt: number;
}

const AUTH_CACHE_TTL_MS = 30_000; // 30 seconds
const authCache = new Map<string, CacheEntry>();

function getCached(jwt: string): CacheEntry | null {
  const entry = authCache.get(jwt);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(jwt);
    return null;
  }
  return entry;
}

function setCache(jwt: string, kolUser: { id: string; email: string }, promoter: Promoter) {
  // Evict oldest entries when the cache grows too large (safety valve).
  if (authCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of authCache) {
      if (now > val.expiresAt) authCache.delete(key);
    }
  }
  authCache.set(jwt, { kolUser, promoter, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
}


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
      /** Supabase auth user, available after kolJwtMiddleware or kolAuthMiddleware runs. */
      kolUser?: { id: string; email: string };
    }
  }
}

/**
 * Verify the Supabase session JWT and return the auth user, or write the
 * 401 response and return null. Shared by both KOL middlewares below.
 */
async function verifyKolJwt(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
): Promise<{ id: string; email: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid Authorization header" } });
    return null;
  }

  const jwt = authHeader.slice(7).trim();
  if (!jwt) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Empty JWT" } });
    return null;
  }

  // Verify JWT via Supabase
  const { data: { user }, error: userErr } = await adminSupabase.auth.getUser(jwt);
  if (userErr || !user || !user.email) {
    res.status(401).json({ error: { code: "INVALID_TOKEN", message: "Invalid or expired JWT" } });
    return null;
  }

  return { id: user.id, email: user.email };
}

/**
 * JWT-only KOL middleware: verifies the Supabase session and attaches
 * `req.kolUser`, WITHOUT requiring an existing promoter row.
 *
 * Used by /auth/register — a new KOL has no promoter row by definition,
 * so requiring one there (the old behavior) made self-registration
 * unreachable (403 NOT_A_KOL on every signup).
 */
export const kolJwtMiddleware: RequestHandler = async (req, res, next) => {
  const user = await verifyKolJwt(req, res);
  if (!user) return;
  req.kolUser = user;
  next();
};

export const kolAuthMiddleware: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  // Fast path: cache hit — attach cached identity and skip all network calls.
  if (jwt) {
    const cached = getCached(jwt);
    if (cached) {
      req.promoter = cached.promoter;
      req.kolUser = cached.kolUser;
      return next();
    }
  }

  const user = await verifyKolJwt(req, res);
  if (!user) return;

  // AS-P1-8 fix: look up promoter row by auth_user_id (stable) first,
  // fall back to email (legacy — pre-auth_user_id migrations). Once
  // the backfill has run (20260714000032) every active promoter has
  // a populated auth_user_id and the email fallback is only used for
  // any pre-backfill orphan rows.
  const { data: promoterByAuthId } = await affiliateSupabase.from("promoters")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("role", "kol")           // PR-1: defend against role='agent' promoters reaching KOL routes
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

  const promoter = (Array.isArray(promoterRows)
    ? promoterRows[0]
    : promoterRows) as Promoter | null;
  if (!promoter) {
    res.status(403).json({
      error: { code: "NOT_A_KOL", message: "No promoter record exists for this user" },
    });
    return;
  }

  if (promoter.status && promoter.status !== "active" && promoter.status !== "pending") {
    res.status(403).json({
      error: { code: "SUSPENDED", message: `Account is ${promoter.status}` },
    });
    return;
  }

  req.promoter = promoter as Promoter;
  req.kolUser = { id: user.id, email: user.email };

  // Store in cache so parallel / subsequent requests skip the network round-trips.
  if (jwt) setCache(jwt, req.kolUser, req.promoter);

  next();
};
