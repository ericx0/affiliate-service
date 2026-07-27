import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies the funnel endpoint's query parsing, RPC invocation and
// response pass-through. The aggregation itself lives in the
// affiliate_admin_funnel RPC (see supabase migration 20260727000006).

const { state } = vi.hoisted(() => ({
  state: {
    rpcCalls: [] as Array<{ fn: string; params: Record<string, any> }>,
    funnelResult: {
      data: [
        {
          promoterId: "p1",
          name: "KOL Zhang",
          role: "kol",
          recruitedByAgentId: "a1",
          clicks: 12,
          ordersAttached: 3,
          ordersPaid: 2,
          ordersCompleted: 1,
          gmvCents: 60000,
          commissionCents: 3000,
          commissionPaidCents: 1000,
        },
      ],
      totals: {
        clicks: 12,
        ordersAttached: 3,
        ordersPaid: 2,
        ordersCompleted: 1,
        gmvCents: 60000,
        commissionCents: 3000,
        commissionPaidCents: 1000,
      },
    } as Record<string, any>,
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {
    rpc: async (fn: string, params?: Record<string, any>) => {
      state.rpcCalls.push({ fn, params: params ?? {} });
      if (fn === "affiliate_admin_funnel") return { data: state.funnelResult, error: null };
      throw new Error("unmocked rpc " + fn);
    },
  },
  affiliateSupabase: {
    from: () => {
      throw new Error("not used by getFunnel");
    },
  },
  stripe: {},
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { getFunnel } from "./admin.controller.js";

function makeReqRes(query: Record<string, any>) {
  const req: any = { query };
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
  state.rpcCalls = [];
});

describe("getFunnel", () => {
  it("defaults to the last 30 days and passes the RPC result through", async () => {
    const before = Date.now();
    const { req, res } = makeReqRes({});
    await getFunnel(req, res);

    expect(state.rpcCalls).toHaveLength(1);
    const { fn, params } = state.rpcCalls[0];
    expect(fn).toBe("affiliate_admin_funnel");
    const fromMs = new Date(params.p_from).getTime();
    const toMs = new Date(params.p_to).getTime();
    // p_to ≈ now; p_from ≈ now - 30d
    expect(toMs).toBeGreaterThanOrEqual(before - 5000);
    expect(toMs).toBeLessThanOrEqual(Date.now() + 5000);
    expect(toMs - fromMs).toBe(30 * 24 * 60 * 60 * 1000);

    // Response shape matches the chinamed-admin contract exactly.
    expect(res.body).toEqual(state.funnelResult);
    expect(res.body.data[0].promoterId).toBe("p1");
    expect(res.body.totals.gmvCents).toBe(60000);
  });

  it("explicit from/to: 'to' is inclusive (upper bound = to + 1 day)", async () => {
    const { req, res } = makeReqRes({ from: "2026-07-01", to: "2026-07-20" });
    await getFunnel(req, res);

    const { params } = state.rpcCalls[0];
    expect(params.p_from).toBe("2026-07-01T00:00:00.000Z");
    expect(params.p_to).toBe("2026-07-21T00:00:00.000Z");
    expect(res.body.totals.clicks).toBe(12);
  });

  it("rejects malformed dates with 400 and does not call the RPC", async () => {
    const { req, res } = makeReqRes({ from: "07/01/2026" });
    await getFunnel(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(state.rpcCalls).toHaveLength(0);
  });
});
