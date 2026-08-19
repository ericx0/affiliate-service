import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state: staged auth user + promoter row.
const { state } = vi.hoisted(() => ({
  state: {
    user: { id: "u1", email: "subject@example.com" } as null | { id: string; email: string },
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
      // Mirror kol-auth chain but with NO role filter — middleware
      // must accept both 'kol' and 'agent' roles.
      const chain: any = {};
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.maybeSingle = async () => ({ data: state.promoter, error: null });
      chain.single = async () => ({ data: state.promoter, error: null });
      return { select: () => chain };
    },
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { kolOrAgentAuthMiddleware } from "./kol-or-agent-auth.js";

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
  state.user = { id: "u1", email: "subject@example.com" };
  state.promoter = null;
});

describe("kolOrAgentAuthMiddleware", () => {
  it("accepts a role='kol' promoter and sets req.subject", async () => {
    state.promoter = {
      id: "k1",
      email: "kol@example.com",
      name: "KOL One",
      status: "active",
      role: "kol",
      country_code: "US",
    };
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer kol-jwt";
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.subject?.id).toBe("k1");
    expect(req.subject?.role).toBe("kol");
    expect(req.subject?.country_code).toBe("US");
  });

  it("accepts a role='agent' promoter and sets req.subject (the gap)", async () => {
    state.promoter = {
      id: "a1",
      email: "agent@example.com",
      name: "Agent One",
      status: "active",
      role: "agent",
      country_code: "CN",
      stripe_account_id: null,
      stripe_onboarding_completed: false,
    };
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer agent-jwt";
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.subject?.id).toBe("a1");
    expect(req.subject?.role).toBe("agent");
    expect(req.subject?.country_code).toBe("CN");
  });

  it("accepts a 'pending' agent (Stripe onboarding before review)", async () => {
    state.promoter = {
      id: "a2",
      email: "pending-agent@example.com",
      name: "Pending Agent",
      status: "pending",
      role: "agent",
      country_code: "US",
    };
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer pending-agent-jwt";
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.subject?.status).toBe("pending");
  });

  it("rejects 401 when Authorization header missing", async () => {
    const { req, res, next } = makeReqRes();
    req.headers.authorization = undefined;
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects 401 when JWT invalid", async () => {
    state.user = null;
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer bad-jwt";
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects 403 when no promoter row exists for this user", async () => {
    state.promoter = null;
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer no-promoter-jwt";
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_SUBJECT");
  });

  it("rejects 403 when status is suspended/banned", async () => {
    state.promoter = {
      id: "a3",
      email: "suspended@example.com",
      name: "Suspended",
      status: "suspended",
      role: "agent",
    };
    const { req, res, next } = makeReqRes();
    req.headers.authorization = "Bearer suspended-jwt";
    await kolOrAgentAuthMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("SUSPENDED");
  });
});