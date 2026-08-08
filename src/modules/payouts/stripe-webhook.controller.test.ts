import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    commissionsTable: [] as Array<Record<string, unknown>>,
    insertEventResult: { error: null as null | { code: string } },
    // Drives the charge.dispute.closed handler's outcome path:
    //   "won"  → unfreeze to paid/approved (resolution matrix)
    //   "lost" → reverse/void with Stripe transfer reversal (resolution matrix)
    closedStatus: "won" as "won" | "lost",
    closedDisputeId: "dp_1",
  },
}));

vi.mock("../../config.js", () => ({
  env: { STRIPE_WEBHOOK_SECRET: "whsec_test", LOG_LEVEL: "warn", NODE_ENV: "test" },
  stripe: {
    webhooks: { constructEvent: () => ({ id: "evt_test", type: "charge.dispute.created", data: { object: { id: "dp_1", charge: "ch_1", amount: 5000, reason: "fraudulent", metadata: { commissionId: "cm_1" } } } }) },
    transfers: { createReversal: vi.fn(async () => ({})) },
  },
  supabase: {
    from: (table: string) => {
      if (table === "processed_stripe_events") {
        return { insert: async () => state.insertEventResult };
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
          update: (payload: any) => {
            state.commissionsTable[0] = { ...state.commissionsTable[0], ...payload };
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../notifications/notifications.service.js", () => ({
  notifyAdminDispute: vi.fn(async () => {}),
  notifyAdminPayoutFailure: vi.fn(async () => {}),
  notifyKolDisputed: vi.fn(async () => {}),
  notifyAdminDisputeResolved: vi.fn(async () => {}),
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
  state.commissionsTable = [{
    id: "cm_1", status: "paid", promoter_id: "p_1", order_id: "o_1",
    commission_amount: 50, dispute_id: null, dispute_status: null,
  }];
  state.insertEventResult = { error: null };
});

describe("charge.dispute.created", () => {
  it("freezes commission to status='disputed' and writes dispute_id+dispute_status='open'", async () => {
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("disputed");
    expect(state.commissionsTable[0].dispute_id).toBe("dp_1");
    expect(state.commissionsTable[0].dispute_status).toBe("open");
  });
});

describe("charge.dispute.closed", () => {
  // Override the default constructEvent (which returns charge.dispute.created)
  // to emit charge.dispute.closed with the desired outcome and commissionId.
  const installClosedEvent = async (closedStatus: "won" | "lost", closedDisputeId: string, commissionId: string) => {
    state.closedStatus = closedStatus;
    state.closedDisputeId = closedDisputeId;
    const config = await import("../../config.js");
    (config.stripe.webhooks.constructEvent as any) = () => ({
      id: `evt_test_${closedStatus}_${closedDisputeId}`,
      type: "charge.dispute.closed",
      data: { object: { id: closedDisputeId, status: closedStatus, metadata: { commissionId } } },
    });
  };

  it("won + wasPaid (paid_at NOT NULL) → status='paid' (un-freeze, no re-fire)", async () => {
    state.commissionsTable[0] = {
      id: "cm_1", status: "disputed", promoter_id: "p_1", order_id: "o_1",
      commission_amount: 50, dispute_id: "dp_1", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_1",
    };
    await installClosedEvent("won", "dp_1", "cm_1");
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("paid");
    expect(state.commissionsTable[0].dispute_status).toBe("won");
    expect(state.commissionsTable[0].dispute_closed_at).not.toBeNull();
  });

  it("won + !wasPaid → status='approved' (un-freeze, eligible for next payout)", async () => {
    state.commissionsTable[0] = {
      id: "cm_2", status: "disputed", promoter_id: "p_2", order_id: "o_2",
      commission_amount: 50, dispute_id: "dp_2", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    };
    await installClosedEvent("won", "dp_2", "cm_2");
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("approved");
  });

  it("lost + wasPaid → status='reversed' (claw back via Stripe transfer)", async () => {
    state.commissionsTable[0] = {
      id: "cm_3", status: "disputed", promoter_id: "p_3", order_id: "o_3",
      commission_amount: 50, dispute_id: "dp_3", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_3",
    };
    await installClosedEvent("lost", "dp_3", "cm_3");
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("reversed");
    expect(state.commissionsTable[0].dispute_closed_at).not.toBeNull();
  });

  it("lost + !wasPaid → status='voided' (cancel pending commission)", async () => {
    state.commissionsTable[0] = {
      id: "cm_4", status: "disputed", promoter_id: "p_4", order_id: "o_4",
      commission_amount: 50, dispute_id: "dp_4", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    };
    await installClosedEvent("lost", "dp_4", "cm_4");
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("voided");
  });
});