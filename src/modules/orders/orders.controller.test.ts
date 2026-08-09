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
    refundEventDeletes: [] as string[],
  },
}));

vi.mock("../../config.js", () => {
  // orders.controller.ts queries affiliate.* tables (refund_events,
  // commissions) via the schema-scoped affiliateSupabase client with
  // unprefixed table names. The same handler backs both clients.
  const fromHandler = (table: string) => {
    if (table === "refund_events") {
      return {
        insert: vi.fn(async () => ({ error: state.insertError })),
        delete: vi.fn(() => ({
          eq: vi.fn((col: string, val: string) => {
            state.refundEventDeletes.push(`${col}=${val}`);
            return { error: null };
          }),
        })),
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
            // Awaited by onOrderPaid's CAS update (.eq().is()).
            is: vi.fn(() => ({
              get error() {
                return null;
              },
            })),
            in: vi.fn(() => ({
              // Awaited by direct UPDATE in onOrderRefunded (destructure { error }).
              // Also chained by transition(): .in().select().single().
              // Used by onOrderDisputeResolved's CAS guard (.in("status", ["disputed"])).
              get error() {
                return null;
              },
              select: vi.fn(() => ({
                // onOrderDisputeResolved awaits .select("id") → returns rows array.
                get data() {
                  // Mirror the .in() guard behaviour: if the row's status
                  // isn't "disputed", return empty so update_succeeded=false.
                  const target = state.commissions[0];
                  return target && target.status === "disputed" ? [{ id: target.id }] : [];
                },
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
  };
  return {
    env: {
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
    },
    supabase: {
      from: vi.fn(fromHandler),
    },
    affiliateSupabase: {
      from: vi.fn(fromHandler),
    },
    stripe: {
      transfers: {
        createReversal: vi.fn(async () => ({ id: "trr_1" })),
      },
    },
  };
});

// Notification mocks for the dispute handlers.
vi.mock("../notifications/notifications.service.js", () => ({
  notifyAdminDispute: vi.fn(async () => {}),
  notifyKolDisputed: vi.fn(async () => {}),
  notifyAdminDisputeResolved: vi.fn(async () => {}),
  notifyAdminDisputeReversalFailed: vi.fn(async () => {}),
}));

vi.mock("../admin/audit.service.js", () => ({
  writeAuditLog: vi.fn(async () => true),
}));

import { onOrderRefunded, onOrderPaid, onOrderCompleted, onOrderDisputed, onOrderDisputeResolved } from "./orders.controller.js";
import { supabase, stripe } from "../../config.js";
import { writeAuditLog } from "../admin/audit.service.js";
import {
  notifyKolDisputed,
  notifyAdminDispute,
  notifyAdminDisputeResolved,
  notifyAdminDisputeReversalFailed,
} from "../notifications/notifications.service.js";

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
    state.refundEventDeletes = [];
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
    expect(json).toBeDefined();
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
    expect(json).toBeDefined();
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
    expect(json).toBeDefined();
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

  it("Stripe reversal failure: returns 500 + rolls back refund_events claim; retry succeeds", async () => {
    // First call: Stripe createReversal throws -> controller must roll back
    // the refund_events claim (DELETE by event_id) + return 500 so Stripe
    // retries the webhook. No commission_amount update should be applied.
    stageCommission({
      id: "c_retry",
      status: "paid",
      stripe_transfer_id: "tr_retry",
      commission_amount: 100,
      order_amount: 2000,
    });
    const stripeErr = new Error("Stripe API timeout");
    (stripe.transfers.createReversal as any).mockRejectedValueOnce(stripeErr);

    const req1: any = {
      body: { eventId: "evt_retry_1", orderId: UUID, refundAmount: 400, reason: "retry test" },
    };
    const r1 = makeRes();
    await onOrderRefunded(req1, r1.res);
    // 500 response so Stripe retries the webhook
    expect(r1.status).toHaveBeenCalledWith(500);
    expect(r1.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "STRIPE_REVERSAL_FAILED" }) }),
    );
    // refund_events claim rolled back so retry re-processes from scratch
    expect(state.refundEventDeletes).toContain("event_id=evt_retry_1");
    // No commission_amount update applied on failure
    expect(state.updateCalls.length).toBe(0);

    // Second call: Stripe createReversal succeeds -> full flow completes.
    state.updateCalls = [];
    state.refundEventDeletes = [];
    state.insertError = null;  // refund_events insert succeeds on retry
    const req2: any = {
      body: { eventId: "evt_retry_1", orderId: UUID, refundAmount: 400, reason: "retry test" },
    };
    const r2 = makeRes();
    await onOrderRefunded(req2, r2.res);
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 1 }));
    expect(r2.status).not.toHaveBeenCalledWith(500);
    // Stripe reversal called with eventId-scoped idempotency key (reuses same key on retry)
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_retry",
      expect.objectContaining({
        amount: 20,  // 20% of 100 = 20 (cents)
        metadata: expect.objectContaining({ eventId: "evt_retry_1" }),
      }),
      { idempotencyKey: "commission-reverse-c_retry-evt_retry_1" },
    );
    // DB updated with new amounts (100 -> 80, cumulative 0 -> 400)
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        commission_amount: 80,
        cumulative_refunded_amount: 400,
      }),
    );
    // No refund_events DELETE on success
    expect(state.refundEventDeletes.length).toBe(0);
  });

  it("multi-commission independent deduction: service + agent_service both adjusted", async () => {
    // Same order with two commission rows (KOL service + agent_service override).
    // Partial refund 400 (20% of order_amount 2000) -> each row independently
    // deducts 20% of its commission_amount. commissionsAffected = 2.
    const kol = {
      id: "c_kol",
      status: "cooling_down",
      order_amount: 2000,
      commission_amount: 100,   // 5% of 2000 (KOL)
      cumulative_refunded_amount: 0,
      stripe_transfer_id: null,
    };
    const agent = {
      id: "c_agent",
      status: "cooling_down",
      order_amount: 2000,
      commission_amount: 20,    // 1% of 2000 (agent override)
      cumulative_refunded_amount: 0,
      stripe_transfer_id: null,
    };
    state.commissions = [kol, agent];
    state.commission = kol;  // single() returns whatever; not used in loop path
    state.insertError = null;
    state.updateCalls = [];

    const req: any = {
      body: { eventId: "evt_multi_commission", orderId: UUID, refundAmount: 400, reason: "multi" },
    };
    const { json, status, res } = makeRes();
    await onOrderRefunded(req, res);
    expect(status).not.toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsAffected: 2 }));

    // KOL: 100 - 20% (20) = 80, cumulative 0 -> 400
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        commission_amount: 80,
        cumulative_refunded_amount: 400,
      }),
    );
    // Agent: 20 - 20% (4) = 16, cumulative 0 -> 400
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        commission_amount: 16,
        cumulative_refunded_amount: 400,
      }),
    );
  });
});

describe("onOrderPaid / onOrderCompleted idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.insertError = null;
    state.updateCalls = [];
  });

  it("onOrderPaid sets order_paid_at once; replay is a no-op", async () => {
    stageCommission({ status: "pending", order_paid_at: null });
    const req: any = { body: { orderId: UUID, occurredAt: "2026-07-20T00:00:00.000Z" } };
    const r1 = makeRes();
    await onOrderPaid(req, r1.res);
    expect(r1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsUpdated: 1 }));
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ order_paid_at: "2026-07-20T00:00:00.000Z" }),
    );

    // Replay (e.g. second caller): order_paid_at already set -> skip.
    stageCommission({ status: "pending", order_paid_at: "2026-07-20T00:00:00.000Z" });
    state.updateCalls = [];
    const r2 = makeRes();
    await onOrderPaid(req, r2.res);
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsUpdated: 0 }));
    expect(state.updateCalls.length).toBe(0);
  });

  it("onOrderPaid never touches terminal (refunded/reversed) commissions", async () => {
    stageCommission({ status: "refunded", order_paid_at: null });
    const req: any = { body: { orderId: UUID } };
    const r = makeRes();
    await onOrderPaid(req, r.res);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsUpdated: 0 }));
    expect(state.updateCalls.length).toBe(0);
  });

  it("onOrderCompleted transitions pending -> cooling_down; replay is a no-op", async () => {
    stageCommission({ status: "pending" });
    const req: any = { body: { orderId: UUID, occurredAt: "2026-07-21T00:00:00.000Z" } };
    const r1 = makeRes();
    await onOrderCompleted(req, r1.res);
    expect(r1.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsCooled: 1 }));
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ status: "cooling_down" }),
    );

    // Replay: commission already cooling_down -> nothing transitions.
    stageCommission({ status: "cooling_down" });
    state.updateCalls = [];
    const r2 = makeRes();
    await onOrderCompleted(req, r2.res);
    expect(r2.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsCooled: 0 }));
    expect(state.updateCalls.length).toBe(0);
  });
});

// Touch imports so type-checker knows they're used (mocked module is replaced at runtime)
void supabase;
void stripe;

describe("onOrderDisputed (internal HMAC endpoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.insertError = null;
    state.updateCalls = [];
    state.commissions = [];
    state.commission = {};
  });

  it("freezes matching commission to status='disputed' and writes dispute_id+dispute_status='open'", async () => {
    stageCommission({
      id: "cm_1", status: "approved", promoter_id: "p_1", order_id: UUID,
      commission_amount: 5000, dispute_id: null, dispute_status: null,
    });
    const req: any = {
      body: { disputeId: "dp_1", orderId: UUID, amountCents: 5000, currency: "usd", reason: "fraudulent", status: "needs_response" },
    };
    const { json, status, res } = makeRes();
    await onOrderDisputed(req, res);
    expect(status).not.toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsFrozen: 1 }));
    // Commission was updated to disputed.
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({
        status: "disputed",
        dispute_id: "dp_1",
        dispute_status: "open",
      }),
    );
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_freeze",
      targetId: "cm_1",
    }));
    expect(notifyKolDisputed).toHaveBeenCalledWith({
      promoterId: "p_1",
      commissionId: "cm_1",
      amount: "50.00", // cents→display string conversion
      disputeReason: "fraudulent",
    });
    expect(notifyAdminDispute).toHaveBeenCalled();
  });

  it("is idempotent: replay with same disputeId skips freeze + notifications", async () => {
    stageCommission({
      id: "cm_2", status: "disputed", promoter_id: "p_2", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_2", dispute_status: "open",
    });
    state.updateCalls = [];
    const req: any = {
      body: { disputeId: "dp_2", orderId: UUID, amountCents: 5000, currency: "usd", reason: "fraudulent", status: "needs_response" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputed(req, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsFrozen: 0 }));
    expect(state.updateCalls).toHaveLength(0);
    expect(notifyKolDisputed).not.toHaveBeenCalled();
  });

  it("returns success with commissionsFrozen=0 when no commissions match the orderId", async () => {
    state.commissions = [];
    const req: any = {
      body: { disputeId: "dp_x", orderId: UUID, amountCents: 5000, currency: "usd", reason: "fraudulent", status: "needs_response" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputed(req, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsFrozen: 0 }));
  });
});

describe("onOrderDisputeResolved (internal HMAC endpoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.insertError = null;
    state.updateCalls = [];
    state.commissions = [];
    state.commission = {};
  });

  it("won + wasPaid → status='paid' (un-freeze, money already went out)", async () => {
    stageCommission({
      id: "cm_1", status: "disputed", promoter_id: "p_1", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_1", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_1",
    });
    const req: any = {
      body: { disputeId: "dp_1", orderId: UUID, outcome: "won" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true, commissionsResolved: 1 }));
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ status: "paid", dispute_status: "won" }),
    );
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith(expect.objectContaining({
      commissionId: "cm_1",
      action: "won",
    }));
  });

  it("won + !wasPaid → status='approved' (un-freeze, eligible for next payout)", async () => {
    stageCommission({
      id: "cm_2", status: "disputed", promoter_id: "p_2", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_2", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    });
    const req: any = {
      body: { disputeId: "dp_2", orderId: UUID, outcome: "won" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ status: "approved", dispute_status: "won" }),
    );
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith(expect.objectContaining({
      action: "won",
    }));
  });

  it("lost + wasPaid → status='reversed' + stripe.transfers.createReversal with commission-level idempotencyKey", async () => {
    stageCommission({
      id: "cm_3", status: "disputed", promoter_id: "p_3", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_3", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_3",
    });
    const req: any = {
      body: { disputeId: "dp_3", orderId: UUID, outcome: "lost" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ status: "reversed", dispute_status: "lost" }),
    );
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_3",
      expect.objectContaining({
        metadata: { commissionId: "cm_3", disputeId: "dp_3", reason: "dispute_lost" },
      }),
      { idempotencyKey: "commission-reversal-cm_3" },
    );
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith(expect.objectContaining({
      action: "lost",
    }));
  });

  it("lost + !wasPaid → status='voided' (cancel pending commission)", async () => {
    stageCommission({
      id: "cm_4", status: "disputed", promoter_id: "p_4", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_4", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    });
    const req: any = {
      body: { disputeId: "dp_4", orderId: UUID, outcome: "lost" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ status: "voided", dispute_status: "lost" }),
    );
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith(expect.objectContaining({
      action: "lost",
    }));
  });

  it("warning_closed outcome is treated as won (no money was forcefully taken)", async () => {
    stageCommission({
      id: "cm_5", status: "disputed", promoter_id: "p_5", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_5", dispute_status: "open",
      dispute_closed_at: null, paid_at: null, stripe_transfer_id: null,
    });
    const req: any = {
      body: { disputeId: "dp_5", orderId: UUID, outcome: "warning_closed" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    expect(state.updateCalls).toContainEqual(
      expect.objectContaining({ status: "approved", dispute_status: "won" }),
    );
  });

  it("lost + wasPaid + createReversal THROWS → status stays 'disputed', reversal_failed audit + ops email", async () => {
    // stageCommission first so the row is in 'disputed' state (passes the
    // .in("status", ["disputed"]) guard in the test mock).
    stageCommission({
      id: "cm_rev_fail", status: "disputed", promoter_id: "p_rev", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_rev", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_rev",
    });
    // Now make createReversal throw for this single call.
    (stripe.transfers.createReversal as any).mockImplementationOnce(() => {
      throw new Error("Stripe API timeout");
    });
    const req: any = {
      body: { disputeId: "dp_rev", orderId: UUID, outcome: "lost" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    // We hit `continue` after the reversal failure, so the DB was NOT
    // updated and no "resolved" notification fired.
    expect(state.updateCalls).toHaveLength(0);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_reversal_failed",
      targetId: "cm_rev_fail",
    }));
    expect(notifyAdminDisputeReversalFailed).toHaveBeenCalledWith({
      commissionId: "cm_rev_fail",
      transferId: "tr_rev",
      error: expect.stringContaining("Stripe API timeout"),
    });
    expect(notifyAdminDisputeResolved).not.toHaveBeenCalled();
  });

  it("UPDATE .in('status', ['disputed']) guard rejects already-resolved commissions", async () => {
    // stage a commission NOT in 'disputed' so the .in() guard returns []
    stageCommission({
      id: "cm_race", status: "paid", promoter_id: "p_race", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_race", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_race",
    });
    const req: any = {
      body: { disputeId: "dp_race", orderId: UUID, outcome: "lost" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    // Guard rejected → audit log fires UNCONDITIONALLY with
    // update_succeeded=false so the trail survives the race (R2 audit
    // fix Q1: money may have moved via the reversal; we MUST leave a
    // trail even if the DB row was already settled).
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_dispute_resolve",
      targetId: "cm_race",
      afterState: expect.objectContaining({ update_succeeded: false }),
    }));
    // Ops notification also fires (unconditional) so admins see the race.
    expect(notifyAdminDisputeResolved).toHaveBeenCalledWith(expect.objectContaining({
      commissionId: "cm_race",
      action: "lost",
      note: expect.stringContaining("dp_race"),
    }));
  });

  it("is idempotent: replay with same disputeId + closed_at skips resolve", async () => {
    stageCommission({
      id: "cm_idem", status: "paid", promoter_id: "p_idem", order_id: UUID,
      commission_amount: 5000, dispute_id: "dp_idem", dispute_status: "won",
      dispute_closed_at: "2026-08-02T00:00:00Z",
      paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_idem",
    });
    const req: any = {
      body: { disputeId: "dp_idem", orderId: UUID, outcome: "won" },
    };
    const { json, res } = makeRes();
    expect(json).toBeDefined();
    await onOrderDisputeResolved(req, res);
    expect(state.updateCalls).toHaveLength(0);
    expect(notifyAdminDisputeResolved).not.toHaveBeenCalled();
  });
});
