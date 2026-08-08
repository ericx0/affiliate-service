import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, mocks } = vi.hoisted(() => ({
  state: {
    logRow: null as null | {
      id: string;
      promoter_id: string | null;
      to_email: string;
      category: string | null;
      sent_at: string | null;
      last_error: string | null;
    },
    promoterRow: null as null | { id: string; email: string; name: string },
    auditCalls: [] as Array<Record<string, unknown>>,
    resendCalls: [] as Array<{ category: string; email: string; promoterId?: string }>,
  },
  mocks: {
    notifyKolCommissionPending: vi.fn(async (...args: unknown[]) => {
      state.resendCalls.push({ category: "commission_pending", email: (args[0] as { email: string }).email, promoterId: (args[0] as { promoterId?: string }).promoterId });
    }),
    notifyKolCommissionReversed: vi.fn(async (...args: unknown[]) => {
      state.resendCalls.push({ category: "commission_reversed", email: (args[0] as { email: string }).email, promoterId: (args[0] as { promoterId?: string }).promoterId });
    }),
    notifyKolCommissionPaid: vi.fn(async (...args: unknown[]) => {
      state.resendCalls.push({ category: "commission_paid", email: (args[0] as { email: string }).email, promoterId: (args[0] as { promoterId?: string }).promoterId });
    }),
    notifyKolPayoutSent: vi.fn(async (...args: unknown[]) => {
      state.resendCalls.push({ category: "payout_sent", email: (args[0] as { email: string }).email, promoterId: (args[0] as { promoterId?: string }).promoterId });
    }),
    notifyKolPayoutFailed: vi.fn(async (...args: unknown[]) => {
      state.resendCalls.push({ category: "payout_failed", email: (args[0] as { email: string }).email, promoterId: (args[0] as { promoterId?: string }).promoterId });
    }),
    notifyKolNewReferral: vi.fn(async (...args: unknown[]) => {
      state.resendCalls.push({ category: "new_referral", email: (args[0] as { email: string }).email, promoterId: (args[0] as { promoterId?: string }).promoterId });
    }),
  },
}));

vi.mock("../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test" },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "affiliate_email_sends") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.logRow, error: null }),
            }),
          }),
        };
      }
      if (table === "promoters") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.promoterRow, error: null }),
            }),
          }),
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../admin/audit.service.js", () => ({
  writeAuditLog: async (input: Record<string, unknown>) => {
    state.auditCalls.push(input);
    return true;
  },
}));

vi.mock("./notifications.service.js", () => ({
  notifyKolCommissionPending: (...args: unknown[]) => mocks.notifyKolCommissionPending(...args),
  notifyKolCommissionReversed: (...args: unknown[]) => mocks.notifyKolCommissionReversed(...args),
  notifyKolCommissionPaid: (...args: unknown[]) => mocks.notifyKolCommissionPaid(...args),
  notifyKolPayoutSent: (...args: unknown[]) => mocks.notifyKolPayoutSent(...args),
  notifyKolPayoutFailed: (...args: unknown[]) => mocks.notifyKolPayoutFailed(...args),
  notifyKolNewReferral: (...args: unknown[]) => mocks.notifyKolNewReferral(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { resendNotification } from "./notifications.controller.js";

function makeRes(params: Record<string, string>, adminUser?: { id: string; email: string }) {
  return {
    params,
    adminUser,
  } as unknown as import("express").Request;
}

function makeResObj() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as import("express").Response & {
    statusCode: number;
    body: unknown;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.logRow = null;
  state.promoterRow = null;
  state.auditCalls = [];
  state.resendCalls = [];
});

describe("resendNotification", () => {
  it("returns 400 for non-UUID id", async () => {
    const res = makeResObj();
    await resendNotification(makeRes({ id: "not-a-uuid" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("returns 404 when log row is missing", async () => {
    state.logRow = null;
    const res = makeResObj();
    await resendNotification(
      makeRes({ id: "00000000-0000-0000-0000-000000000001" }, { id: "admin-1", email: "admin@x.com" }),
      res,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns 400 ALREADY_SENT when log row has sent_at set", async () => {
    state.logRow = {
      id: "00000000-0000-0000-0000-000000000001",
      promoter_id: "p-1",
      to_email: "kol@example.com",
      category: "payout_sent",
      sent_at: "2026-08-08T00:00:00Z",
      last_error: null,
    };
    state.promoterRow = { id: "p-1", email: "kol@example.com", name: "K" };
    const res = makeResObj();
    await resendNotification(
      makeRes({ id: "00000000-0000-0000-0000-000000000001" }, { id: "admin-1", email: "admin@x.com" }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "ALREADY_SENT" } });
    expect(mocks.notifyKolPayoutSent).not.toHaveBeenCalled();
  });

  it("202 + audit + notifyKolPayoutSent when log row is failed", async () => {
    state.logRow = {
      id: "00000000-0000-0000-0000-000000000001",
      promoter_id: "p-1",
      to_email: "kol@example.com",
      category: "payout_sent",
      sent_at: null,
      last_error: "send failed after 3 attempts",
    };
    state.promoterRow = { id: "p-1", email: "kol@example.com", name: "K" };
    const res = makeResObj();
    await resendNotification(
      makeRes({ id: "00000000-0000-0000-0000-000000000001" }, { id: "admin-1", email: "admin@x.com" }),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(mocks.notifyKolPayoutSent).toHaveBeenCalledTimes(1);
    expect(state.resendCalls[0]).toMatchObject({ category: "payout_sent", email: "kol@example.com", promoterId: "p-1" });
    expect(state.auditCalls).toHaveLength(1);
    expect(state.auditCalls[0].action).toBe("notification_resend");
  });
});