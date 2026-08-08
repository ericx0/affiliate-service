import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state: staged agent lookup / referral-code rows and the
// params captured on the registration RPC call.
const { state } = vi.hoisted(() => ({
  state: {
    agentRow: null as null | { id: string },
    refCodeRow: null as null | { promoter_id: string; promoters: { id: string; role: string; status: string } },
    registerRpcParams: null as null | Record<string, any>,
    registerRpcError: null as null | { code: string; message: string },
    existingForUserRow: null as null | { id: string; role: string },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {
    rpc: async (fn: string, params?: Record<string, any>) => {
      if (fn === "rate_limit_consume") return { data: [{ allowed: true }], error: null };
      if (fn === "affiliate_self_register_promoter") {
        state.registerRpcParams = params ?? null;
        if (state.registerRpcError) {
          return { data: null, error: state.registerRpcError };
        }
        return { data: { promoter: { id: "p-new" }, code: "NEWCODE1" }, error: null };
      }
      throw new Error("unmocked rpc " + fn);
    },
    // documents.templates lookups (NDA + Affiliate Agreement).
    schema: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { id: "tpl-1", content_hash: "hash-1", version: 1 },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "promoters") {
        // Two distinct promoters-table queries in this controller:
        //   1. agent_invite_code lookup (line ~193): selects "id" only,
        //      filtered by agent_invite_code + role + status. Returns
        //      state.agentRow.
        //   2. F-NEW-5 pre-check (line ~131 after the patch): selects
        //      "id, role", filtered by auth_user_id. Returns
        //      state.existingForUserRow.
        // We disambiguate by which columns the SELECT requests.
        return {
          select: (cols: string) => {
            const n: any = {
              eq: (_col: string, _val: unknown) => {
                // F-NEW-5 disambiguation: if the SELECT includes
                // "role" AND we're called via .eq("auth_user_id", ...),
                // return state.existingForUserRow. Otherwise return
                // state.agentRow.
                if (cols.includes("role") && _col === "auth_user_id") {
                  n._existing = true;
                }
                return n;
              },
              maybeSingle: async () => {
                if (n._existing) {
                  return { data: state.existingForUserRow, error: null };
                }
                return { data: state.agentRow, error: null };
              },
            };
            return n;
          },
        };
      }
      if (table === "referral_codes") {
        return {
          select: (cols: string) => {
            const node: any = {
              eq: () => node,
              maybeSingle: async () => {
                // Binding lookup selects the joined promoters row; the
                // post-register notify lookup selects just "code".
                if (cols.includes("promoters!inner")) {
                  return state.refCodeRow
                    ? { data: state.refCodeRow, error: null }
                    : { data: null, error: { message: "not found" } };
                }
                return { data: { code: "NEWCODE1" }, error: null };
              },
            };
            return node;
          },
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../notifications/notifications.service.js", () => ({
  notifyAdminNewKol: vi.fn(async () => {}),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { selfRegister } from "./register.controller.js";

const UID = "11111111-1111-4111-8111-111111111111";

function makeReqRes(body: Record<string, any>, query: Record<string, any> = {}) {
  const req: any = {
    body,
    query,
    kolUser: { id: UID, email: "kol@example.com" },
    get: () => undefined,
    ip: "203.0.113.1",
  };
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
  return { req, res };
}

function validBody(extra: Record<string, any> = {}) {
  return {
    authUserId: UID,
    name: "KOL Zhang",
    email: "kol@example.com",
    countryCode: "US",
    primaryPlatform: "x",
    primaryPlatformUrl: "https://x.com/kolzhang",
    consent_confirmed: true,
    ...extra,
  };
}

beforeEach(() => {
  state.agentRow = null;
  state.refCodeRow = null;
  state.registerRpcParams = null;
  state.registerRpcError = null;
  state.existingForUserRow = null;
});

describe("selfRegister — mandatory agent binding", () => {
  it("no invite code at all -> 400 INVITE_CODE_REQUIRED, RPC not called", async () => {
    const { req, res } = makeReqRes(validBody());
    await selfRegister(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVITE_CODE_REQUIRED");
    expect(res.body.error.message).toMatch(/invite code/i);
    expect(state.registerRpcParams).toBeNull();
  });

  it("invalid body agent_invite_code -> 400 INVALID_INVITE_CODE", async () => {
    state.agentRow = null; // lookup finds no active agent
    const { req, res } = makeReqRes(validBody({ agent_invite_code: "BADC0DE" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITE_CODE");
    expect(state.registerRpcParams).toBeNull();
  });

  it("invalid ?agent= query code -> 400 INVALID_INVITE_CODE", async () => {
    const { req, res } = makeReqRes(validBody(), { agent: "BADC0DE" });
    await selfRegister(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITE_CODE");
    expect(state.registerRpcParams).toBeNull();
  });

  it("invite code of a deactivated agent -> 400 INVALID_INVITE_CODE", async () => {
    // A deactivated agent's code no longer matches the status='active'
    // filter, so the lookup returns no row — same rejection as invalid.
    state.agentRow = null;
    const { req, res } = makeReqRes(validBody({ agent_invite_code: "OLDC0DE" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITE_CODE");
    expect(state.registerRpcParams).toBeNull();
  });

  it("valid body agent_invite_code -> 201, bound to the resolved agent", async () => {
    state.agentRow = { id: "agent-1" };
    const { req, res } = makeReqRes(validBody({ agent_invite_code: "GOODC0DE" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(201);
    expect(state.registerRpcParams?.p_recruited_by_agent_id).toBe("agent-1");
  });

  it("valid ?agent= query code -> 201, bound to the resolved agent", async () => {
    state.agentRow = { id: "agent-2" };
    const { req, res } = makeReqRes(validBody(), { agent: "GOODC0DE" });
    await selfRegister(req, res);
    expect(res.statusCode).toBe(201);
    expect(state.registerRpcParams?.p_recruited_by_agent_id).toBe("agent-2");
  });

  it("referralCode fallback: code owned by an active agent -> 201, bound correctly", async () => {
    state.refCodeRow = {
      promoter_id: "agent-3",
      promoters: { id: "agent-3", role: "agent", status: "active" },
    };
    const { req, res } = makeReqRes(validBody({ referralCode: "AGENT123" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(201);
    expect(state.registerRpcParams?.p_recruited_by_agent_id).toBe("agent-3");
  });

  it("referralCode owned by a regular KOL (not an agent) -> 400 INVALID_INVITE_CODE", async () => {
    state.refCodeRow = {
      promoter_id: "kol-1",
      promoters: { id: "kol-1", role: "kol", status: "active" },
    };
    const { req, res } = makeReqRes(validBody({ referralCode: "KOLCODE1" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITE_CODE");
    expect(state.registerRpcParams).toBeNull();
  });

  it("unknown referralCode -> 400 INVALID_INVITE_CODE", async () => {
    state.refCodeRow = null;
    const { req, res } = makeReqRes(validBody({ referralCode: "NOSUCH01" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITE_CODE");
    expect(state.registerRpcParams).toBeNull();
  });
});

describe("selfRegister — F-NEW-5 single-email single-role guard", () => {
  it("auth_user_id already owns a role='agent' row -> 409 EMAIL_HAS_AGENT_ROLE, RPC not called", async () => {
    // Simulates: admin-v2 created an Agent with this email earlier;
    // user now tries to self-register as KOL with the same email.
    state.existingForUserRow = { id: "agent-row", role: "agent" };
    const { req, res } = makeReqRes(validBody({ agent_invite_code: "GOODC0DE" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_HAS_AGENT_ROLE");
    expect(res.body.error.message).toMatch(/registered as an Agent/i);
    expect(state.registerRpcParams).toBeNull();
  });

  it("auth_user_id already owns a role='kol' row -> 23505 ALREADY_REGISTERED (existing path)", async () => {
    // Sanity: the new pre-check only blocks the *Agent* role; an
    // existing KOL row is caught by the existing 23505 SQLSTATE handler.
    state.existingForUserRow = { id: "kol-row", role: "kol" };
    state.agentRow = { id: "agent-1" };
    // Force the RPC to throw the duplicate-key error to exercise the
    // existing handler.
    state.registerRpcError = { code: "23505", message: "duplicate key value violates unique constraint" };
    const { req, res } = makeReqRes(validBody({ agent_invite_code: "GOODC0DE" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REGISTERED");
  });

  it("no existing row for auth_user_id -> pre-check passes, registration continues", async () => {
    // existingForUserRow = null simulates a fresh user
    state.agentRow = { id: "agent-1" };
    const { req, res } = makeReqRes(validBody({ agent_invite_code: "GOODC0DE" }));
    await selfRegister(req, res);
    expect(res.statusCode).toBe(201);
    expect(state.registerRpcParams?.p_recruited_by_agent_id).toBe("agent-1");
  });
});
