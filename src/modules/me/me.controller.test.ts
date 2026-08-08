import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state for staging referral_codes count/insert results.
const { state } = vi.hoisted(() => ({
  state: {
    activeCodeCount: 0,
    inserts: [] as Array<Record<string, any>>,
    profileRpc: null as null | { data: Record<string, any> | null; error: null },
    updateCalls: [] as Array<Record<string, any>>,
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
      if (table === "referral_codes") {
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
      }
      if (table === "promoters") {
        return {
          update: (row: Record<string, any>) => {
            state.updateCalls.push(row);
            return {
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: {
                      id: "p1",
                      name: row.name ?? "",
                      email: "kol@example.com",
                      country_code: row.country_code ?? "",
                      primary_platform: row.primary_platform ?? "",
                      primary_platform_url: row.primary_platform_url ?? null,
                      bio: row.bio ?? "",
                      phone: row.phone ?? null,
                      social_accounts: row.social_accounts ?? {},
                      preferred_locale: row.preferred_locale ?? "en",
                      avatar_url: row.avatar_url ?? "",
                    },
                    error: null,
                  }),
                }),
              }),
            };
          },
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

import { createMyCode, getMe, updateMe } from "./me.controller.js";

function makeReqRes(status: string | undefined) {
  const req: any = {
    promoter: status === undefined ? undefined : { id: "p1", email: "kol@example.com", status },
  };
  const res: any = {
    statusCode: 200, // Express default for res.json() without explicit status()
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
  state.updateCalls = [];
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

describe("PATCH /me updateMe", () => {
  function makePatchReq(body: unknown) {
    const { req, res } = makeReqRes("active");
    req.body = body;
    return { req, res };
  }

  // Brief cases (1-11) + P0 bonus (12-14)
  it("accepts bio and echoes it back", async () => {
    const { req, res } = makePatchReq({ bio: "I am a KOL" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.bio).toBe("I am a KOL");
    expect(state.updateCalls[0].bio).toBe("I am a KOL");
  });

  it("accepts phone with international format", async () => {
    const { req, res } = makePatchReq({ phone: "+1 555-1234" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.phone).toBe("+1 555-1234");
    expect(state.updateCalls[0].phone).toBe("+1 555-1234");
  });

  it("accepts socialAccounts as a record of string pairs", async () => {
    const { req, res } = makePatchReq({ socialAccounts: { twitter: "@handle" } });
    await updateMe(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.socialAccounts).toEqual({ twitter: "@handle" });
    expect(state.updateCalls[0].social_accounts).toEqual({ twitter: "@handle" });
  });

  it("accepts preferredLocale in the 5-locale enum", async () => {
    const { req, res } = makePatchReq({ preferredLocale: "zh" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.preferredLocale).toBe("zh");
  });

  it("rejects preferredLocale outside the 5-locale enum", async () => {
    const { req, res } = makePatchReq({ preferredLocale: "fr" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  it("accepts a valid avatarUrl", async () => {
    const { req, res } = makePatchReq({ avatarUrl: "https://example.com/a.jpg" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.avatarUrl).toBe("https://example.com/a.jpg");
  });

  it("rejects bio longer than 500 chars", async () => {
    const { req, res } = makePatchReq({ bio: "x".repeat(501) });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  it("rejects phone that fails the regex", async () => {
    const { req, res } = makePatchReq({ phone: "abc" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  it("rejects socialAccounts that is not an object", async () => {
    const { req, res } = makePatchReq({ socialAccounts: 123 });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  it("rejects unknown fields (strict mode) — email", async () => {
    const { req, res } = makePatchReq({ email: "x@y.com" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  it("rejects unknown fields (strict mode) — role", async () => {
    const { req, res } = makePatchReq({ role: "agent" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  // P0 #2 bonus: empty phone string is accepted and stored as null
  it("accepts empty phone string (P0 fix: literal empty)", async () => {
    const { req, res } = makePatchReq({ phone: "" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(200);
    expect(state.updateCalls[0].phone).toBeNull();
    expect(res.body.data.phone).toBeNull();
  });

  // P0 #1 bonus: extra commission_rate is rejected by strict mode
  it("rejects commission_rate (camelCase unknown field, strict mode)", async () => {
    const { req, res } = makePatchReq({ commissionRate: 0.5 });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });

  // Negative: avatarUrl that is not a URL must fail
  it("rejects avatarUrl that is not a valid URL", async () => {
    const { req, res } = makePatchReq({ avatarUrl: "not-a-url" });
    await updateMe(req, res);
    expect(res.statusCode).toBe(400);
    expect(state.updateCalls).toHaveLength(0);
  });
});
