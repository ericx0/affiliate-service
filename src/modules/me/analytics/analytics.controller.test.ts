import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    clicks: [] as Array<Record<string, any>>,
    codes: [] as Array<Record<string, any>>,
    profiles: [] as Array<Record<string, any>>,
    orders: [] as Array<Record<string, any>>,
    commissions: [] as Array<Record<string, any>>,
    followupCount: 4 as number,
  },
}));

vi.mock("../../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test" },
  supabase: {
    from: (table: string) => {
      if (table === "orders") {
        return {
          select: () => ({
            eq: () => ({
              gte: async () => ({ data: state.orders, error: null }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            in: () => ({
              gte: async () => ({ data: state.profiles, error: null }),
            }),
          }),
        };
      }
      throw new Error("unmocked supabase table " + table);
    },
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "referral_clicks") {
        return {
          select: () => ({
            eq: () => ({
              gte: async () => ({ data: state.clicks, error: null }),
            }),
          }),
        };
      }
      if (table === "referral_codes") {
        return {
          select: () => ({
            eq: async () => ({ data: state.codes, error: null }),
          }),
        };
      }
      if (table === "commissions") {
        return {
          select: () => ({
            eq: () => ({
              gte: async () => ({ data: state.commissions, error: null }),
            }),
          }),
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { getMyAnalytics } from "./analytics.controller.js";

function makeReqRes(promoterId: string | undefined, query: Record<string, any> = {}) {
  const req: any = {
    query,
    promoter: promoterId ? { id: promoterId, email: "kol@example.com", status: "active" } : undefined,
  };
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) {
      if (this.statusCode === 0) this.statusCode = 200;
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

beforeEach(() => {
  state.clicks = [];
  state.codes = [];
  state.profiles = [];
  state.orders = [];
  state.commissions = [];
});

describe("GET /me/analytics — auth + validation", () => {
  it("returns 401 when no promoter context", async () => {
    const { req, res } = makeReqRes(undefined);
    await getMyAnalytics(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for days outside the {7,30,90} whitelist", async () => {
    const { req, res } = makeReqRes("p1", { days: "14" });
    await getMyAnalytics(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("defaults to 30 days when query is omitted", async () => {
    const { req, res } = makeReqRes("p1");
    await getMyAnalytics(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.days).toBe(30);
    // Trend bucket count must equal days.
    expect(res.body.trend).toHaveLength(30);
  });

  it("returns the aggregated clicks/signups/orders/commission + breakdowns", async () => {
    state.codes = [{ code: "ABCD1234" }, { code: "WXYZ5678" }];
    state.clicks = [
      { id: "c1", country: "CN", clicked_at: "2026-07-29T10:00:00Z" },
      { id: "c2", country: "CN", clicked_at: "2026-07-30T03:00:00Z" },
      { id: "c3", country: "US", clicked_at: "2026-07-30T05:00:00Z" },
    ];
    state.profiles = [
      { id: "u1", referred_by: "ABCD1234", created_at: "2026-07-29T00:00:00Z" },
    ];
    state.orders = [
      { id: "o1", checkup_package_id: "pkg-hair", checkup_package_name: "Hair Loss", total_amount: 999, currency: "USD", paid_at: "2026-07-30T00:00:00Z", created_at: "2026-07-30T00:00:00Z" },
    ];
    state.commissions = [
      { id: "cm1", commission_amount: 49.95, currency: "USD", order_paid_at: "2026-07-30T00:00:00Z", created_at: "2026-07-30T00:00:00Z", order_id: "o1" },
    ];
    const { req, res } = makeReqRes("p1", { days: "30" });
    await getMyAnalytics(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.clicks).toBe(3);
    expect(res.body.signups).toBe(1);
    expect(res.body.orders).toBe(1);
    // 49.95 → 4995 cents.
    expect(res.body.commission_cents).toBe(4995);
    expect(res.body.currency).toBe("USD");
    expect(res.body.by_product[0]).toMatchObject({ id: "pkg-hair", count: 1 });
    expect(res.body.by_country[0]).toMatchObject({ key: "CN", count: 2 });
    // Language is derived from country — China → zh-CN.
    expect(res.body.by_language[0]).toMatchObject({ key: "zh-CN", count: 2 });
  });
});