import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    configRow: null as null | { mode: "first_click" | "last_click"; window_days: number },
    codeRow: { promoter_id: "promoter-1", is_active: true, expires_at: null as string | null },
    existingClicks: [] as Array<{
      id: string;
      first_click_at: string;
      last_click_at: string;
      clicked_at?: string;
      converted_order_id?: string | null;
    }>,
    dedupCutoff: null as string | null,
    inserts: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
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
              single: async () =>
                state.configRow
                  ? { data: state.configRow, error: null }
                  : { data: null, error: { code: "PGRST116" } },
            }),
          }),
        };
      }

      if (table === "referral_codes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: state.codeRow, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === "referral_clicks") {
        const filteredQuery = {
          eq: () => filteredQuery,
          gte: (_column: string, cutoff: string) => {
            state.dedupCutoff = cutoff;
            return filteredQuery;
          },
          limit: async () => ({ data: state.existingClicks, error: null }),
        };
        return {
          select: () => filteredQuery,
          update: (row: Record<string, unknown>) => {
            state.updates.push(row);
            return { eq: async () => ({ error: null }) };
          },
          insert: (row: Record<string, unknown>) => {
            state.inserts.push(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: "click-1", ...row }, error: null }),
              }),
            };
          },
        };
      }

      throw new Error(`unmocked table ${table}`);
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

beforeEach(() => {
  vi.resetModules();
  state.configRow = null;
  state.existingClicks = [];
  state.dedupCutoff = null;
  state.inserts = [];
  state.updates = [];
});

afterEach(() => vi.useRealTimers());

describe("getAttributionConfig", () => {
  it("returns defaults when the global row is missing", async () => {
    const { getAttributionConfig } = await import("./clicks.service.js");

    await expect(getAttributionConfig()).resolves.toEqual({
      mode: "last_click",
      windowDays: 30,
    });
  });

  it("returns the configured global values", async () => {
    state.configRow = { mode: "first_click", window_days: 45 };
    const { getAttributionConfig } = await import("./clicks.service.js");

    await expect(getAttributionConfig()).resolves.toEqual({
      mode: "first_click",
      windowDays: 45,
    });
  });
});

it("uses a fixed one-hour dedup window regardless of config", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
  state.configRow = { mode: "last_click", window_days: 30 };
  const { trackClick } = await import("./clicks.service.js");

  await trackClick({ referralCode: "ABCD1234", ipAddress: "203.0.113.10" });

  expect(state.dedupCutoff).toBe("2026-08-07T23:00:00.000Z");
});

describe("trackClick attribution mode", () => {
  it("first_click keeps first_click_at and updates last_click_at", async () => {
    state.configRow = { mode: "first_click", window_days: 30 };
    state.existingClicks = [{
      id: "existing-click",
      first_click_at: "2026-08-01T00:00:00.000Z",
      last_click_at: "2026-08-01T00:00:00.000Z",
    }];
    const { trackClick } = await import("./clicks.service.js");

    await trackClick({ referralCode: "ABCD1234", visitorSessionId: "550e8400-e29b-41d4-a716-446655440000" });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toHaveProperty("last_click_at");
    expect(state.updates[0]).not.toHaveProperty("first_click_at");
  });

  it("last_click overwrites both attribution timestamps", async () => {
    state.configRow = { mode: "last_click", window_days: 30 };
    state.existingClicks = [{
      id: "existing-click",
      first_click_at: "2026-08-01T00:00:00.000Z",
      last_click_at: "2026-08-01T00:00:00.000Z",
    }];
    const { trackClick } = await import("./clicks.service.js");

    await trackClick({ referralCode: "ABCD1234", visitorSessionId: "550e8400-e29b-41d4-a716-446655440000" });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toHaveProperty("first_click_at");
    expect(state.updates[0]).toHaveProperty("last_click_at");
    expect(state.updates[0]).not.toHaveProperty("clicked_at");
  });

  it("inserts a new click when the recent click is already converted", async () => {
    state.existingClicks = [{
      id: "converted-click",
      first_click_at: "2026-08-08T00:00:00.000Z",
      last_click_at: "2026-08-08T00:00:00.000Z",
      clicked_at: "2026-08-08T00:00:00.000Z",
      converted_order_id: "order-1",
    }];
    const { trackClick } = await import("./clicks.service.js");

    await trackClick({ referralCode: "ABCD1234", ipAddress: "203.0.113.10" });

    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(1);
  });

  it("writes coupon as the click source", async () => {
    const { trackClick } = await import("./clicks.service.js");

    await trackClick({ referralCode: "ABCD1234", source: "coupon" });

    expect(state.inserts[0]).toMatchObject({ source: "coupon" });
  });
});

describe("isWithinAttributionWindow", () => {
  it("returns false after the configured environment window", async () => {
    const { isWithinAttributionWindow } = await import("./clicks.service.js");
    const clickedAt = new Date();
    clickedAt.setDate(clickedAt.getDate() - 31);

    expect(isWithinAttributionWindow(clickedAt.toISOString())).toBe(false);
  });
});
