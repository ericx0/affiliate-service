import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state so each test can stage commission rows + insert errors
// without re-initializing the module mock. vi.hoisted runs before vi.mock
// factories are evaluated, so `state` is visible inside the factory closure.
const { state } = vi.hoisted(() => ({
  state: {
    commission: {} as Record<string, any>,
    commissions: [] as Record<string, any>[],
    insertError: null as null | { code: string; message: string },
    updateCalls: [] as any[],
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {
    from: vi.fn((table: string) => {
      if (table === "affiliate.refund_events") {
        return {
          insert: vi.fn(async () => ({ error: state.insertError })),
        };
      }
      // commissions table
      return {
        insert: vi.fn(async () => ({ error: state.insertError })),
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            // Awaited directly by getCommissionsForOrder (destructure { data }).
            // Getters keep the value dynamic per-test.
            get data() {
              return state.commissions;
            },
            get error() {
              return null;
            },
            maybeSingle: vi.fn(async () => ({
              data: state.commission,
              error: null,
            })),
            single: vi.fn(async () => ({
              data: state.commission,
              error: null,
            })),
            in: vi.fn(() => ({
              data: state.commissions,
              error: null,
            })),
          })),
        })),
        update: vi.fn((payload: any) => {
          state.updateCalls.push(payload);
          return {
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                // Awaited by direct UPDATE in onOrderRefunded (destructure { error }).
                // Also chained by transition(): .in().select().single().
                get error() {
                  return null;
                },
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: state.commission,
                    error: null,
                  })),
                })),
              })),
            })),
          };
        }),
      };
    }),
  },
  stripe: {
    transfers: {
      createReversal: vi.fn(async () => ({ id: "trr_1" })),
    },
  },
}));

import { onOrderRefunded } from "./orders.controller.js";
import { supabase, stripe } from "../../config.js";

const UUID = "00000000-0000-0000-0000-000000000001";

function makeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { json, status, res: { json, status } as any };
}

function stageCommission(over: Partial<Record<string, any>> = {}) {
  const c = {
    id: "c1",
    status: "cooling_down",
    order_amount: 2000,
    commission_amount: 100,
    cumulative_refunded_amount: 0,
    stripe_transfer_id: null,
    ...over,
  };
  state.commission = c;
  state.commissions = [c];
  state.insertError = null;
  state.updateCalls = [];
  return c;
}

describe("onOrderRefunded - partial refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.insertError = null;
    state.updateCalls = [];
  });

  it("deducts commission proportionally for partial refund (cooling_down)", async () => {
    // order_amount 2000, commission 100 (5%), refund 400 (20%)
    // -> deduct 20, cumulative_refunded 400, status stays cooling_down
    stageCommission();
    const req: any = {
      body: { eventId: "evt_p1", orderId: UUID, refundAmount: 400, reason: "partial" },
    };
    const { json, status, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(status).not.toHaveBeenCalledWith(501);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    // Verify proportional deduction: commission_amount 100 -> 80, cumulative 0 -> 400
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        commission_amount: 80,
        cumulative_refunded_amount: 400,
      }),
    );
  });

  it("paid status partial refund: calls reversePaidCommission(amount=deductAmount) then updates DB", async () => {
    // commission status=paid, stripe_transfer_id set, refund 400 (20%)
    // -> deduct 20, Stripe reversal called with amount=20, DB updated to 80/400
    stageCommission({
      status: "paid",
      stripe_transfer_id: "tr_123",
    });
    const req: any = {
      body: { eventId: "evt_paid_1", orderId: UUID, refundAmount: 400, reason: "partial paid" },
    };
    const { json, status, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(status).not.toHaveBeenCalledWith(501);
    // Stripe reversal called with the deduct amount (20) + eventId-scoped idempotency
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_123",
      expect.objectContaining({
        amount: 20,
        metadata: expect.objectContaining({
          commissionId: "c1",
          eventId: "evt_paid_1",
        }),
      }),
      { idempotencyKey: "commission-reverse-c1-evt_paid_1" },
    );
    // DB updated with new amounts (status stays paid since not fully refunded)
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        commission_amount: 80,
        cumulative_refunded_amount: 400,
      }),
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
  });

  it("multiple partial refunds accumulate to full: final call transitions to refunded", async () => {
    // First refund 400 (20%) -> cumulative 400, commission 80, stays cooling_down
    // Second refund 1600 (80%) -> cumulative 2000 = order_amount, transition to refunded
    stageCommission();
    const req1: any = {
      body: { eventId: "evt_multi_1", orderId: UUID, refundAmount: 400, reason: "first" },
    };
    const r1 = makeRes();
    await onOrderRefunded(req1, r1.res);
    expect(r1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    expect(r1.status).not.toHaveBeenCalledWith(501);
    // Verify first deduction: 100 -> 80, cumulative 0 -> 400
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        commission_amount: 80,
        cumulative_refunded_amount: 400,
      }),
    );
    // No transition to refunded yet (no status: "refunded" in update calls)
    expect(state.updateCalls.some((u) => u.status === "refunded")).toBe(false);

    // Simulate DB state after first refund (next read returns updated row)
    stageCommission({
      commission_amount: 80,
      cumulative_refunded_amount: 400,
    });
    state.updateCalls = [];  // reset for second call assertions
    const req2: any = {
      body: { eventId: "evt_multi_2", orderId: UUID, refundAmount: 1600, reason: "second" },
    };
    const r2 = makeRes();
    await onOrderRefunded(req2, r2.res);
    // Second call: cumulative 400 + 1600 = 2000 = order_amount -> transition to refunded
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    // transition() calls supabase update with status: "refunded" + final amounts
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "refunded",
        commission_amount: 16,  // 80 - (80 * 1600 / 2000) = 80 - 64 = 16
        cumulative_refunded_amount: 2000,
      }),
    );
  });

  it("full refund (refundAmount = order_amount): transitions to refunded (regression)", async () => {
    // refundAmount = order_amount = 2000 -> single full refund, transition to refunded
    stageCommission();
    const req: any = {
      body: { eventId: "evt_full_1", orderId: UUID, refundAmount: 2000, reason: "full" },
    };
    const { json, status, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(status).not.toHaveBeenCalledWith(501);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    // transition() updates status to "refunded" with commission 0, cumulative 2000
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "refunded",
        commission_amount: 0,
        cumulative_refunded_amount: 2000,
      }),
    );
  });

  it("undefined refundAmount (no refundAmount field): transitions to refunded (legacy full)", async () => {
    // refundAmount undefined -> treated as full refund -> transition to refunded
    stageCommission();
    const req: any = {
      body: { eventId: "evt_legacy_1", orderId: UUID, reason: "legacy full" },
    };
    const { json, status, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(status).not.toHaveBeenCalledWith(501);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "refunded",
        cumulative_refunded_amount: 2000,
      }),
    );
  });

  it("idempotent: duplicate eventId returns duplicate:true without re-applying", async () => {
    // First insert succeeds; second insert returns 23505 (unique violation)
    stageCommission();
    const req: any = {
      body: { eventId: "evt_dup", orderId: UUID, refundAmount: 400, reason: "first" },
    };
    const r1 = makeRes();
    await onOrderRefunded(req, r1.res);
    expect(r1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));

    // Second call with same eventId: insert returns 23505
    state.insertError = { code: "23505", message: "duplicate key" };
    state.updateCalls = [];
    const req2: any = {
      body: { eventId: "evt_dup", orderId: UUID, refundAmount: 400, reason: "second" },
    };
    const r2 = makeRes();
    await onOrderRefunded(req2, r2.res);
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, duplicate: true }));
    // No commission update should happen on duplicate
    expect(state.updateCalls.length).toBe(0);
  });

  it("paid full refund: transitions to reversed (not refunded)", async () => {
    // paid status + full refund -> Stripe reversal for full amount -> transition to reversed
    stageCommission({
      status: "paid",
      stripe_transfer_id: "tr_456",
    });
    const req: any = {
      body: { eventId: "evt_paid_full", orderId: UUID, refundAmount: 2000, reason: "paid full" },
    };
    const { json, status, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(status).not.toHaveBeenCalledWith(501);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    // Stripe reversal called with full commission amount (100)
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_456",
      expect.objectContaining({
        amount: 100,
        metadata: expect.objectContaining({ eventId: "evt_paid_full" }),
      }),
      { idempotencyKey: "commission-reverse-c1-evt_paid_full" },
    );
    // transition() updates status to "reversed" (paid -> reversed, not refunded)
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "reversed",
        cumulative_refunded_amount: 2000,
      }),
    );
  });

  it("already terminal commission (refunded) is skipped", async () => {
    // commission already in refunded state -> skip, no update
    stageCommission({ status: "refunded" });
    const req: any = {
      body: { eventId: "evt_skip", orderId: UUID, refundAmount: 400, reason: "skip" },
    };
    const { json, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 0 }));
    expect(state.updateCalls.length).toBe(0);
  });

  it("no commissions for order: returns 0 affected", async () => {
    state.commissions = [];
    state.commission = {};
    state.insertError = null;
    state.updateCalls = [];
    const req: any = {
      body: { eventId: "evt_empty", orderId: UUID, refundAmount: 400, reason: "empty" },
    };
    const { json, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 0 }));
  });

  it("refundAmount exceeds remaining: clamped to remaining (no over-deduction)", async () => {
    // cumulative already 1800 of 2000; refund 500 -> clamped to 200, transitions to refunded
    stageCommission({
      commission_amount: 10,  // 5% of remaining 200
      cumulative_refunded_amount: 1800,
    });
    const req: any = {
      body: { eventId: "evt_clamp", orderId: UUID, refundAmount: 500, reason: "clamp" },
    };
    const { json, res } = makeRes();
    await onOrderRefunded(req, res);
    // effectiveRefund = min(500, 2000-1800) = 200; newCumulative = 2000 -> transition to refunded
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "refunded",
        cumulative_refunded_amount: 2000,
      }),
    );
  });
});

// Touch imports so type-checker knows they're used (mocked module is replaced at runtime)
void supabase;
void stripe;
