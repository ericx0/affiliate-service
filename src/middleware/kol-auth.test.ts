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
  // lookup succeeds, but must exist.
  supabase: {
    rpc: async () => ({ data: state.promoter ? [state.promoter] : [], error: null }),
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "promoters") throw new Error("unmocked table " + table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.promoter, error: null }),
          }),
        }),
      };
    },
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { kolAuthMiddleware } from "./kol-auth.js";

function makeReqRes() {
  const req: any = { headers: { authorization: "Bearer test-jwt" } };
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
