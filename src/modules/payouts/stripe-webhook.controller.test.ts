import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    commissionsTable: [] as Array<Record<string, unknown>>,
    insertEventResult: { error: null as null | { code: string } },
    constructEvent: vi.fn(),
    createReversal: vi.fn(async () => ({})),
  },
}));

vi.mock("../../config.js", () => ({
  env: { STRIPE_WEBHOOK_SECRET: "whsec_test", LOG_LEVEL: "warn", NODE_ENV: "test" },
  stripe: {
    webhooks: { constructEvent: state.constructEvent },
    transfers: { createReversal: state.createReversal },
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
import { stripe } from "../../config.js";
import { writeAuditLog } from "../admin/audit.service.js";
import {
  notifyKolDisputed,
  notifyAdminDispute,
  notifyAdminDisputeResolved,
} from "../notifications/notifications.service.js";

const SYSTEM_WEBHOOK_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  state.commissionsTable = [{
    id: "cm_1", status: "paid", promoter_id: "p_1", order_id: "o_1",
    commission_amount: 50, dispute_id: null, dispute_status: null,
  }];
  state.insertEventResult = { error: null };
  state.constructEvent.mockReturnValue({
    id: "evt_test",
    type: "charge.dispute.created",
    data: { object: { id: "dp_1", charge: "ch_1", amount: 5000, reason: "fraudulent", metadata: { commissionId: "cm_1" } } },
  });
  vi.clearAllMocks();
});

describe("charge.dispute.created", () => {
  it("freezes commission to status='disputed' and writes dispute_id+dispute_status='open'", async () => {
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("disputed");
    expect(state.commissionsTable[0].dispute_id).toBe("dp_1");
    expect(state.commissionsTable[0].dispute_status).toBe("open");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_freeze",
      actorId: SYSTEM_WEBHOOK_ACTOR_ID,
      targetId: "cm_1",
    }));
    expect(notifyKolDisputed).toHaveBeenCalledWith({
      promoterId: "p_1",
      commissionId: "cm_1",
      amount: 50,
      disputeReason: "fraudulent",
    });
    expect(notifyAdminDispute).toHaveBeenCalled();
  });
});

describe("charge.dispute.closed", () => {
  it("won + wasPaid (paid_at NOT NULL) → status='paid' (un-freeze, no re-fire)", async () => {
    state.commissionsTable[0] = {
      id: "cm_1", status: "disputed", promoter_id: "p_1", order_id: "o_1",
      commission_amount: 50, dispute_id: "dp_1", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_1",
    };
    state.constructEvent.mockReturnValue({
      id: "evt_test_won_dp_1",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_1", status: "won", metadata: { commissionId: "cm_1" } } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("paid");
    expect(state.commissionsTable[0].dispute_status).toBe("won");
    expect(state.commissionsTable[0].dispute_closed_at).not.toBeNull();
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_resolve",
      targetId: "cm_1",
    }));
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith({
      commissionId: "cm_1",
      action: "won",
      note: expect.stringContaining("stripe_dispute"),
    });
  });

  it("won + !wasPaid → status='approved' (un-freeze, eligible for next payout)", async () => {
    state.commissionsTable[0] = {
      id: "cm_2", status: "disputed", promoter_id: "p_2", order_id: "o_2",
      commission_amount: 50, dispute_id: "dp_2", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    };
    state.constructEvent.mockReturnValue({
      id: "evt_test_won_dp_2",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_2", status: "won", metadata: { commissionId: "cm_2" } } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("approved");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_resolve",
      targetId: "cm_2",
    }));
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith({
      commissionId: "cm_2",
      action: "won",
      note: expect.stringContaining("stripe_dispute"),
    });
  });

  it("lost + wasPaid → status='reversed' (claw back via Stripe transfer)", async () => {
    state.commissionsTable[0] = {
      id: "cm_3", status: "disputed", promoter_id: "p_3", order_id: "o_3",
      commission_amount: 50, dispute_id: "dp_3", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_3",
    };
    state.constructEvent.mockReturnValue({
      id: "evt_test_lost_dp_3",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_3", status: "lost", metadata: { commissionId: "cm_3" } } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("reversed");
    expect(state.commissionsTable[0].dispute_closed_at).not.toBeNull();
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith("tr_3", expect.objectContaining({
      metadata: { commissionId: "cm_3", disputeId: "dp_3", reason: "dispute_lost" },
    }));
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_resolve",
      targetId: "cm_3",
    }));
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith({
      commissionId: "cm_3",
      action: "lost",
      note: expect.stringContaining("stripe_dispute"),
    });
  });

  it("lost + !wasPaid → status='voided' (cancel pending commission)", async () => {
    state.commissionsTable[0] = {
      id: "cm_4", status: "disputed", promoter_id: "p_4", order_id: "o_4",
      commission_amount: 50, dispute_id: "dp_4", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    };
    state.constructEvent.mockReturnValue({
      id: "evt_test_lost_dp_4",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_4", status: "lost", metadata: { commissionId: "cm_4" } } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(state.commissionsTable[0].status).toBe("voided");
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_resolve",
      targetId: "cm_4",
    }));
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith({
      commissionId: "cm_4",
      action: "lost",
      note: expect.stringContaining("stripe_dispute"),
    });
  });
});
