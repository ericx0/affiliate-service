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
    listRows: [] as Array<Record<string, unknown>>,
    listError: null as null | { message: string },
    listCalls: [] as Array<Record<string, unknown>>,
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

/**
 * Supabase-style chainable + thenable query builder. Records every chained
 * call (select/order/eq/limit) on the active builder so tests can assert
 * filter shape; pushes the recorded snapshot to state.listCalls when the
 * builder is awaited (so all chained filters are captured in one record).
 */
function listChainBuilder() {
  const recorded: Record<string, unknown> = {};
  const target: Record<string, unknown> & { then?: unknown } = {
    select: (...args: unknown[]) => {
      recorded.select = args;
      return target;
    },
    order: (...args: unknown[]) => {
      recorded.order = args;
      return target;
    },
    eq: (col: string, val: unknown) => {
      recorded[`eq:${col}`] = val;
      return target;
    },
    limit: (n: number) => {
      recorded.limit = n;
      return target;
    },
    maybeSingle: () => {
      recorded.maybeSingle = true;
      state.listCalls.push({ ...recorded });
      return Promise.resolve({ data: state.logRow, error: null });
    },
  };
  target.then = (onFulfilled: (v: unknown) => unknown) => {
    state.listCalls.push({ ...recorded });
    return Promise.resolve({ data: state.listRows, error: state.listError }).then(onFulfilled);
  };
  return target;
}

vi.mock("../../config.js", () => ({
  env: { LOG_LEVEL: "warn", NODE_ENV: "test" },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "affiliate_email_sends") {
        return listChainBuilder();
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
import { listNotifications } from "./notifications.controller.js";

function makeRes(params: Record<string, string>, adminUser?: { id: string; email: string }) {
  return {
    params,
    adminUser,
  } as unknown as import("express").Request;
}

function makeResObj() {
  const res = {
    statusCode: 200,
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
  state.listRows = [];
  state.listError = null;
  state.listCalls = [];
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

// ---- Task 3.3: listNotifications (GET /admin/notifications) ----

function makeListReq(query: Record<string, unknown>, adminUser?: { id: string; email: string }) {
  return {
    query,
    adminUser,
  } as unknown as import("express").Request;
}

describe("listNotifications", () => {
  it("returns 200 with derived status (sent/failed/pending) and joined promoter email", async () => {
    state.listRows = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        promoter_id: "p-1",
        template_id: "t-1",
        category: "payout_sent",
        to_email: "kol-a@example.com",
        sent_at: "2026-08-08T00:00:00Z",
        last_error: null,
        created_at: "2026-08-08T01:00:00Z",
        promoters: { email: "kol-a@example.com" },
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        promoter_id: "p-2",
        template_id: "t-2",
        category: "payout_failed",
        to_email: "kol-b@example.com",
        sent_at: null,
        last_error: "send failed after 3 attempts",
        created_at: "2026-08-08T02:00:00Z",
        promoters: { email: "kol-b@company.com" },
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        promoter_id: null,
        template_id: "t-3",
        category: "new_referral",
        to_email: "lead@example.com",
        sent_at: null,
        last_error: null,
        created_at: "2026-08-08T03:00:00Z",
        promoters: null,
      },
    ];
    const res = makeResObj();
    await listNotifications(makeListReq({}), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({ status: "sent", promoter_email: "kol-a@example.com" });
    expect(body.data[1]).toMatchObject({ status: "failed", promoter_email: "kol-b@company.com" });
    expect(body.data[2]).toMatchObject({ status: "pending", promoter_email: null });
  });

  it("forwards category filter to the query chain", async () => {
    state.listRows = [];
    const res = makeResObj();
    await listNotifications(makeListReq({ category: "payout_failed" }), res);
    expect(res.statusCode).toBe(200);
    expect(state.listCalls).toHaveLength(1);
    const call = state.listCalls[0];
    expect(call["eq:category"]).toBe("payout_failed");
    expect(call.limit).toBe(50);
  });

  it("returns 400 on bad limit (zod max 200)", async () => {
    const res = makeResObj();
    await listNotifications(makeListReq({ limit: "999" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(state.listCalls).toHaveLength(0);
  });

  it("does not gate on adminUser (auth is enforced by adminAuthMiddleware upstream)", async () => {
    state.listRows = [];
    const res = makeResObj();
    // adminAuthMiddleware rejects unauthorized requests before the controller
    // is reached; the controller itself is read-only and admin-unaware by
    // design (mirrors resendNotification above). The smoke check confirms
    // the chain executes without crashing on a missing adminUser shape.
    await listNotifications(makeListReq({}, undefined), res);
    expect(res.statusCode).toBe(200);
    expect(state.listCalls).toHaveLength(1);
  });
});