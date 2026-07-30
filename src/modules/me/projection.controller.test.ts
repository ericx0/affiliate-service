import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    commissions: [] as Array<Record<string, any>>,
  },
}));

vi.mock("../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test" },
  affiliateSupabase: {
    from: (table: string) => {
      if (table !== "commissions") throw new Error("unmocked table " + table);
      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ data: state.commissions, error: null }),
          }),
        }),
      };
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { getMyProjection } from "./projection.controller.js";

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
  state.commissions = [];
});

describe("GET /me/commission-projection", () => {
  it("returns 401 when no promoter context", async () => {
    const { req, res } = makeReqRes(undefined);
    await getMyProjection(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for an invalid days query", async () => {
    const { req, res } = makeReqRes("p1", { days: "0" });
    await getMyProjection(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns the 30-day average + projection for a KOL with commissions", async () => {
    // Two commissions across the last 7 days, totalling $120 → 12000 cents.
    state.commissions = [
      { commission_amount: 50, currency: "USD", order_paid_at: "2026-07-25T00:00:00Z", created_at: "2026-07-25T00:00:00Z" },
      { commission_amount: 70, currency: "USD", order_paid_at: "2026-07-30T00:00:00Z", created_at: "2026-07-30T00:00:00Z" },
    ];
    const { req, res } = makeReqRes("p1", { days: "30" });
    await getMyProjection(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.currency).toBe("USD");
    expect(res.body.daily_series).toHaveLength(30);
    // Sum across the series equals 12000 cents.
    const seriesTotal = res.body.daily_series.reduce(
      (sum: number, d: any) => sum + d.commission_cents,
      0,
    );
    expect(seriesTotal).toBe(12000);
    // avg_daily_commission_cents = 12000 / 2 active days = 6000 cents.
    expect(res.body.avg_daily_commission_cents).toBe(6000);
    // projection_30d_cents = 6000 * 30 = 180000.
    expect(res.body.projection_30d_cents).toBe(180000);
  });

  it("returns zeros + USD for a KOL with no commissions", async () => {
    const { req, res } = makeReqRes("p1", { days: "30" });
    await getMyProjection(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.commission_cents ?? 0).toBe(0);
    expect(res.body.avg_daily_commission_cents).toBe(0);
    expect(res.body.projection_30d_cents).toBe(0);
    expect(res.body.currency).toBe("USD");
    expect(res.body.daily_series).toHaveLength(30);
  });
});