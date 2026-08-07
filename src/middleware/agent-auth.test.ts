import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state: staged auth user + promoter row.
const { state } = vi.hoisted(() => ({
  state: {
    user: { id: "u1", email: "agent@example.com" } as null | { id: string; email: string },
    promoter: null as null | Record<string, any>,
  },
}));

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
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "promoters") throw new Error("unmocked table " + table);
      // Chainable mock supporting .eq().eq().maybeSingle() / .single().
      // PR-1: the second .eq("role","agent") filter is enforced.
      const chain: any = {};
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        // Only role='agent' rows are visible to this middleware.
        if (state.promoter && state.promoter.role !== "agent") {
          return { data: null, error: null };
        }
        return { data: state.promoter, error: null };
      };
      chain.single = async () => ({ data: state.promoter, error: null });
      return { select: () => chain };
    },
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { agentAuthMiddleware } from "./agent-auth.js";

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
  state.user = { id: "u1", email: "agent@example.com" };
  state.promoter = null;
});

describe("agentAuthMiddleware role gate", () => {
  it("rejects a role='kol' promoter with 403 NOT_AN_AGENT", async () => {
    state.promoter = {
      id: "p2",
      email: "kol@example.com",
      status: "active",
      role: "kol",
    };
    // Use a fresh JWT so the (potential) auth cache doesn't leak.
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer agent-role-gate-jwt";
    await agentAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("NOT_AN_AGENT");
  });
});