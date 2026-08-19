import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state: staged auth user + promoter row. vi.hoisted runs
// before vi.mock factories are evaluated.
const { state } = vi.hoisted(() => ({
  state: {
    user: { id: "u1", email: "kol@example.com" } as null | { id: string; email: string },
    promoter: null as null | Record<string, any>,
  },
}));

// kol-auth creates its own service-role client at module scope.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () =>
        state.user
          ? { data: { user: state.user }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  }),
}));

vi.mock("../config.js", () => ({
  env: {
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-key",
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  // Fallback lookup path (by email) — unused when the auth_user_id
  // lookup succeeds, but must exist. PR-1: also rejects role='agent'
  // here so a row that slips through auth_user_id lookup still cannot
  // reach a KOL route.
  supabase: {
    rpc: async () => {
      if (state.promoter && state.promoter.role === "agent") {
        return { data: [], error: null };
      }
      return { data: state.promoter ? [state.promoter] : [], error: null };
    },
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "promoters") throw new Error("unmocked table " + table);
      // Build a chainable mock that supports any number of `.eq(...)` calls
      // before `.maybeSingle()` / `.single()`. The PR-1 role gate adds a
      // second `.eq("role", "kol")` after `.eq("auth_user_id", user.id)`.
      const chain: any = {};
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        // Simulate the DB role filter: role='agent' rows are invisible here.
        if (state.promoter && state.promoter.role === "agent") {
          return { data: null, error: null };
        }
        return { data: state.promoter, error: null };
      };
      chain.single = async () => ({ data: state.promoter, error: null });
      return {
        select: () => chain,
      };
    },
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { kolAuthMiddleware } from "./kol-auth.js";

// Counter so each call gets a unique JWT — authCache is module-scoped
// with 30s TTL, and reusing 'Bearer test-jwt' across tests means the
// first review-status case (active) populates the cache, and subsequent
// suspended/blacklisted/no-promoter cases hit cache and call next()
// with the stale active promoter. Force cache miss per test.
let jwtCounter = 0;
function makeReqRes(overrideJwt?: string) {
  const jwt = overrideJwt ?? `test-jwt-${++jwtCounter}`;
  const req: any = { headers: { authorization: `Bearer ${jwt}` } };
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  state.user = { id: "u1", email: "kol@example.com" };
  state.promoter = null;
});

describe("kolAuthMiddleware — review-status gate", () => {
  it("allows an active promoter through", async () => {
    state.promoter = { id: "p1", email: "kol@example.com", status: "active" };
    const { req, res, next } = makeReqRes();
    await kolAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.promoter.status).toBe("active");
  });

  it("allows a pending promoter through (portal access during review)", async () => {
    // Pending KOLs may log in and use the portal (tax form, Stripe
    // onboarding, dashboard, payouts/earnings/stats reads). Only
    // POST /me/codes is gated separately in createMyCode.
    state.promoter = { id: "p1", email: "kol@example.com", status: "pending" };
    const { req, res, next } = makeReqRes();
    await kolAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.promoter.status).toBe("pending");
  });

  it("rejects a suspended promoter with 403 SUSPENDED", async () => {
    state.promoter = { id: "p1", email: "kol@example.com", status: "suspended" };
    const { req, res, next } = makeReqRes();
    await kolAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("SUSPENDED");
  });

  it("rejects a blacklisted promoter with 403", async () => {
    state.promoter = { id: "p1", email: "kol@example.com", status: "blacklisted" };
    const { req, res, next } = makeReqRes();
    await kolAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("rejects a signed-in user with no promoter row (403 NOT_A_KOL)", async () => {
    const { req, res, next } = makeReqRes();
    await kolAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_KOL");
  });

  it("rejects a missing Authorization header with 401", async () => {
    const { req, res, next } = makeReqRes();
    req.headers = {};
    await kolAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe("kolAuthMiddleware role gate", () => {
  it("rejects a role='agent' promoter with 403 NOT_A_KOL", async () => {
    state.promoter = {
      id: "p1",
      email: "agent@example.com",
      status: "active",
      role: "agent",
    };
    // Use a fresh JWT so the in-process auth cache (TTL 30s) does not
    // hand back a previous test's cached KOL row.
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer role-gate-jwt";
    await kolAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_KOL");
  });
});
