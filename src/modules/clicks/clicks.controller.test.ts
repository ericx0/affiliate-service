import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state so each test can stage referral code lookups and
// observe referral_clicks inserts. vi.hoisted runs before vi.mock factories.
const { state } = vi.hoisted(() => ({
  state: {
    codeRow: null as null | { promoter_id: string; is_active: boolean; expires_at: string | null },
    existingClicks: [] as Array<{
      id: string;
      first_click_at: string;
      last_click_at: string;
      clicked_at?: string;
      converted_order_id?: string | null;
    }>,
    dedupFilters: [] as Array<[string, unknown]>,
    inserts: [] as Array<Record<string, any>>,
    updates: [] as Array<Record<string, any>>,
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
    ATTRIBUTION_WINDOW_DAYS: 30,
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "attribution_config") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { mode: "last_click", window_days: 30 },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "referral_codes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () =>
                  state.codeRow
                    ? { data: state.codeRow, error: null }
                    : { data: null, error: { message: "not found" } },
              }),
            }),
          }),
        };
      }
      if (table === "referral_clicks") {
        const filteredQuery = {
          eq: (column: string, value: unknown) => {
            state.dedupFilters.push([column, value]);
            return filteredQuery;
          },
          gte: () => filteredQuery,
          limit: async () => ({ data: state.existingClicks, error: null }),
        };
        return {
          select: () => filteredQuery,
          update: (row: Record<string, any>) => {
            state.updates.push(row);
            return { eq: async () => ({ error: null }) };
          },
          insert: (row: Record<string, any>) => {
            state.inserts.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: "click-1", ...row }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { track } from "./clicks.controller.js";

function makeReqRes(body: unknown) {
  const req: any = {
    body,
    ip: "203.0.113.10",
    get: (h: string) => (h === "user-agent" ? "edge-middleware/1.0" : undefined),
  };
  let statusCode = 0;
  let ended = false;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    end() {
      ended = true;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, wasEnded: () => ended };
}

beforeEach(() => {
  state.codeRow = { promoter_id: "p1", is_active: true, expires_at: null };
  state.existingClicks = [];
  state.dedupFilters = [];
  state.inserts = [];
  state.updates = [];
});

describe("POST /api/affiliate/clicks/track", () => {
  it("records a click for a valid code and answers 204", async () => {
    const { req, res, getStatus, wasEnded } = makeReqRes({
      code: "ABCD1234",
      landingPath: "/services/checkup",
      referrer: "https://twitter.com/kol",
      utmSource: "x",
      utmMedium: "social",
      utmCampaign: "launch",
    });
    await track(req, res);
    expect(getStatus()).toBe(204);
    expect(wasEnded()).toBe(true);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      referral_code: "ABCD1234",
      promoter_id: "p1",
      ip_address: "203.0.113.10",
      user_agent: "edge-middleware/1.0",
      landing_path: "/services/checkup",
      referrer: "https://twitter.com/kol",
      utm_source: "x",
      utm_medium: "social",
      utm_campaign: "launch",
    });
  });

  it("answers 204 without writing for an unknown code (no probing)", async () => {
    state.codeRow = null;
    const { req, res, getStatus } = makeReqRes({ code: "ABCD1234" });
    await track(req, res);
    expect(getStatus()).toBe(204);
    expect(state.inserts).toHaveLength(0);
  });

  it("answers 204 without writing for a malformed code", async () => {
    const { req, res, getStatus } = makeReqRes({ code: "!!bad!!" });
    await track(req, res);
    expect(getStatus()).toBe(204);
    expect(state.inserts).toHaveLength(0);
  });

  it("answers 204 for a malformed body", async () => {
    const { req, res, getStatus } = makeReqRes({ landingPath: "/x" }); // no code
    await track(req, res);
    expect(getStatus()).toBe(204);
    expect(state.inserts).toHaveLength(0);
  });

  it("accepts referralCode with coupon source and passes it through", async () => {
    const { req, res, getStatus } = makeReqRes({
      referralCode: "ABCD1234",
      source: "coupon",
      visitorSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });

    await track(req, res);

    expect(getStatus()).toBe(204);
    expect(state.inserts[0]).toMatchObject({
      referral_code: "ABCD1234",
      source: "coupon",
      visitor_session_id: null,
    });
  });

  it("does not let body visitorSessionId bypass IP-keyed dedup", async () => {
    state.existingClicks = [{
      id: "click-existing",
      first_click_at: "2026-08-08T00:00:00.000Z",
      last_click_at: "2026-08-08T00:00:00.000Z",
      clicked_at: "2026-08-08T00:00:00.000Z",
    }];
    const { req, res } = makeReqRes({
      code: "ABCD1234",
      visitorSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });

    await track(req, res);

    expect(state.dedupFilters).toContainEqual(["ip_address", "203.0.113.10"]);
    expect(state.dedupFilters).not.toContainEqual([
      "visitor_session_id",
      "550e8400-e29b-41d4-a716-446655440000",
    ]);
  });

  it("rejects an unknown source with 400", async () => {
    const { req, res, getStatus } = makeReqRes({
      referralCode: "ABCD1234",
      source: "email",
    });

    await track(req, res);

    expect(getStatus()).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it("dedupes repeat clicks from the same IP+code within 1h", async () => {
    state.existingClicks = [{
      id: "click-existing",
      first_click_at: "2026-08-01T00:00:00.000Z",
      last_click_at: "2026-08-01T00:00:00.000Z",
    }];
    const { req, res, getStatus } = makeReqRes({ code: "ABCD1234" });
    await track(req, res);
    expect(getStatus()).toBe(204);
    expect(state.inserts).toHaveLength(0);
  });
});
