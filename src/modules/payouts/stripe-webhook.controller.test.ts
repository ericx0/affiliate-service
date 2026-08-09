import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    commissionsTable: [] as Array<Record<string, unknown>>,
    insertEventResult: { error: null as null | { code: string } },
    constructEvent: vi.fn(),
  },
}));

vi.mock("../../config.js", () => ({
  env: { STRIPE_WEBHOOK_SECRET: "whsec_test", LOG_LEVEL: "warn", NODE_ENV: "test" },
  stripe: {
    webhooks: { constructEvent: state.constructEvent },
    transfers: { createReversal: vi.fn(async () => ({})) },
  },
  supabase: {
    from: (table: string) => {
      if (table === "processed_stripe_events") {
        return {
          insert: async () => state.insertEventResult,
          delete: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
  affiliateSupabase: {
    from: (table: string) => {
      if (table === "commissions") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.commissionsTable[0] ?? null, error: null }) }),
          }),
          update: () => ({
            eq: () => ({
              in: () => ({ select: async () => ({ data: [], error: null }) }),
              select: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === "promoters") {
        return {
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../notifications/notifications.service.js", () => ({
  notifyAdminPayoutFailure: vi.fn(async () => {}),
}));

vi.mock("../commissions/refund-helpers.js", () => ({
  calculateRefundDeduction: vi.fn(() => ({ deductAmount: 0 })),
}));

vi.mock("../admin/audit.service.js", () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { handleStripeWebhook } from "./stripe-webhook.controller.js";

beforeEach(() => {
  state.commissionsTable = [];
  state.insertEventResult = { error: null };
  vi.clearAllMocks();
});

describe("customer dispute events", () => {
  // Customer chargeback events now land on linkchinamed-web (not here)
  // because Stripe fans dispute events to the account that originated the
  // charge — which is the main platform. The freeze / resolve logic
  // moved to orders.controller.ts onOrderDisputed / onOrderDisputeResolved
  // reached via HMAC bridge. This webhook only logs + acks so a stray
  // endpoint pointing here stays debuggable.
  it.each([
    "charge.dispute.created",
    "charge.dispute.closed",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated",
  ])("%s is logged and ignored — no commission writes", async (eventType) => {
    state.constructEvent.mockReturnValue({
      id: `evt_${eventType}`,
      type: eventType,
      data: { object: { id: "dp_1", charge: "ch_1", status: "needs_response" } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(state.commissionsTable).toHaveLength(0);
  });
});