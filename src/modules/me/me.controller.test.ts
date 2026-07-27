import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state for staging referral_codes count/insert results.
const { state } = vi.hoisted(() => ({
  state: {
    activeCodeCount: 0,
    inserts: [] as Array<Record<string, any>>,
    profileRpc: null as null | { data: Record<string, any> | null; error: null },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {
    rpc: async (fn: string) => {
      if (fn === "affiliate_get_me") return state.profileRpc;
      throw new Error("unmocked rpc " + fn);
    },
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "referral_codes") throw new Error("unmocked table " + table);
      return {
        // count query: .select("id", {count, head}).eq().eq() awaited directly
        select: () => ({
          eq: () => ({
            eq: async () => ({ count: state.activeCodeCount, error: null }),
          }),
        }),
        insert: (row: Record<string, any>) => {
          state.inserts.push(row);
          return {
            select: () => ({
              single: async () => ({
                data: { id: "code-1", code: row.code, is_active: true, created_at: "2026-07-27T00:00:00Z" },
                error: null,
              }),
            }),
          };
        },
      };
    },
  },
}));

import { createMyCode, getMe } from "./me.controller.js";

function makeReqRes(status: string | undefined) {
  const req: any = {
    promoter: status === undefined ? undefined : { id: "p1", email: "kol@example.com", status },
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

beforeEach(() => {
  state.activeCodeCount = 0;
  state.inserts = [];
  state.profileRpc = null;
});

describe("getMe — review-state contract", () => {
  it("returns profile.status from the RPC (portal branches on it)", async () => {
    state.profileRpc = {
      data: { name: "K", email: "kol@example.com", countryCode: "US", status: "pending" },
      error: null,
    };
    const { req, res } = makeReqRes("pending");
    await getMe(req, res);
    expect(res.body.data.status).toBe("pending");
  });

  it("falls back to the kol-auth promoter row when the RPC lacks status", async () => {
    // Older affiliate_get_me (pre-migration) has no status field; the
    // controller must still expose one so the portal contract holds.
    state.profileRpc = {
      data: { name: "K", email: "kol@example.com", countryCode: "US" },
      error: null,
    };
    const { req, res } = makeReqRes("pending");
    await getMe(req, res);
    expect(res.body.data.status).toBe("pending");
  });
});

describe("createMyCode — review gate", () => {
  it("rejects a pending promoter (awaiting admin review) with 403", async () => {
    const { req, res } = makeReqRes("pending");
    await createMyCode(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("PROMOTER_NOT_ACTIVE");
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects a suspended promoter with 403", async () => {
    const { req, res } = makeReqRes("suspended");
    await createMyCode(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("PROMOTER_NOT_ACTIVE");
    expect(state.inserts).toHaveLength(0);
  });

  it("allows an active promoter to create a code", async () => {
    const { req, res } = makeReqRes("active");
    await createMyCode(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.data.code).toBe(state.inserts[0].code);
    expect(state.inserts).toHaveLength(1);
  });

  it("returns 401 without promoter context", async () => {
    const { req, res } = makeReqRes(undefined);
    await createMyCode(req, res);
    expect(res.statusCode).toBe(401);
    expect(state.inserts).toHaveLength(0);
  });
});
