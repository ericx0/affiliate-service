import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    commissionsTable: [] as Array<Record<string, unknown>>,
    insertEventResult: { error: null as null | { code: string } },
    constructEvent: vi.fn(),
    createReversal: vi.fn(async () => ({})),
    // R1 final review Fix 3: per-test toggle to make createReversal throw.
    createReversalShouldThrow: false,
  },
}));

vi.mock("../../config.js", () => ({
  env: { STRIPE_WEBHOOK_SECRET: "whsec_test", LOG_LEVEL: "warn", NODE_ENV: "test" },
  stripe: {
    webhooks: { constructEvent: state.constructEvent },
    // Expose the spy directly so test assertions can read its mock.calls.
    // Per-test throws are injected via state.createReversal.mockImplementationOnce
    // (see Fix 3 test below).
    transfers: { createReversal: state.createReversal },
  },
  supabase: {
    from: (table: string) => {
      if (table === "processed_stripe_events") {
        // R1 final review: the catch path on processing failure calls
        // .delete() to release the idempotency claim for Stripe retry.
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
          // R1 final review Fix 4: the dispute.closed UPDATE uses
          // .eq().in("status", ["disputed"]).select("id") — return an
          // object that supports the chain AND honors the .in() guard.
          // (The pre-fix code only had .eq() and applied the update
          // unconditionally, which is what the .in() guard prevents.)
          //
          // The dispute.created path uses .update().eq() (no .select()).
          // Real Supabase fires the UPDATE when the chain ends — we model
          // that with a thenable on .eq() that applies on await.
          update: (payload: any) => {
            const pending = { payload, id: null as string | null, guard: null as string[] | null };
            const apply = () => {
              const current = state.commissionsTable[0];
              if (!current) return { data: [], error: null };
              if (pending.guard && !pending.guard.includes(String(current.status))) {
                return { data: [], error: null };
              }
              state.commissionsTable[0] = { ...current, ...pending.payload };
              return { data: [{ id: pending.id ?? "x" }], error: null };
            };
            return {
              eq: (_col: string, val: string) => {
                pending.id = val;
                // Build the chain object (.in / .select) onto a thenable
                // so awaiting .eq() (without further chain) still applies
                // the update — modeling real Supabase behavior.
                const thenable: any = {
                  in: (_col2: string, vals: string[]) => {
                    pending.guard = vals;
                    return {
                      select: async (_cols: string) => apply(),
                    };
                  },
                  select: async (_cols: string) => apply(),
                };
                thenable.then = (onFulfilled: any, onRejected: any) => {
                  // .eq() without further chain → apply unguarded, resolve.
                  const result = apply();
                  return Promise.resolve(result).then(onFulfilled, onRejected);
                };
                return thenable;
              },
            };
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
  notifyAdminDisputeReversalFailed: vi.fn(async () => {}),
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
  notifyAdminDisputeReversalFailed,
} from "../notifications/notifications.service.js";

const SYSTEM_WEBHOOK_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  state.commissionsTable = [{
    id: "cm_1", status: "paid", promoter_id: "p_1", order_id: "o_1",
    commission_amount: 5000, dispute_id: null, dispute_status: null,
  }];
  state.insertEventResult = { error: null };
  state.createReversalShouldThrow = false;
  state.constructEvent.mockReturnValue({
    id: "evt_test",
    type: "charge.dispute.created",
    data: { object: { id: "dp_1", charge: "ch_1", amount: 5000, reason: "fraudulent", metadata: { commissionId: "cm_1" } } },
  });
  // vi.clearAllMocks() also wipes state.createReversal's implementation;
  // re-install the default success behaviour for every test.
  state.createReversal.mockReset();
  state.createReversal.mockResolvedValue({});
  vi.clearAllMocks();
  state.createReversal.mockResolvedValue({});
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
    expect(notifyAdminDispute).toHaveBeenCalled();
  });

  // R1 final review Fix 1: webhook converts commission_amount (cents) to a
  // pre-formatted USD string before calling notifyKolDisputed. With seed
  // commission_amount = 5000 cents, the helper must receive "50.00" — NOT
  // 5000 (which would render as "5000.00 USD" in the email).
  it("passes cents→USD-string amount to notifyKolDisputed (Fix 1)", async () => {
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    expect(notifyKolDisputed).toHaveBeenCalledWith({
      promoterId: "p_1",
      commissionId: "cm_1",
      amount: "50.00", // 5000 cents / 100, fixed to 2 decimals, STRING
      disputeReason: "fraudulent",
    });
  });
});

describe("charge.dispute.closed", () => {
  it("won + wasPaid (paid_at NOT NULL) → status='paid' (un-freeze, no re-fire)", async () => {
    state.commissionsTable[0] = {
      id: "cm_1", status: "disputed", promoter_id: "p_1", order_id: "o_1",
      commission_amount: 5000, dispute_id: "dp_1", dispute_status: "open",
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
      commission_amount: 5000, dispute_id: "dp_2", dispute_status: "open",
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
      commission_amount: 5000, dispute_id: "dp_3", dispute_status: "open",
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
      commission_amount: 5000, dispute_id: "dp_4", dispute_status: "open",
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

  // R1 final review Fix 3: when stripe.transfers.createReversal throws,
  // the commission must NOT flip to 'reversed'. Leave status as 'disputed',
  // write a commission_reversal_failed audit row, and alert ops via
  // notifyAdminDisputeReversalFailed — do NOT fire notifyAdminDisputeResolved
  // (the dispute is not actually resolved).
  it("lost + wasPaid + createReversal THROWS → status stays 'disputed', reversal_failed audit + ops email (Fix 3)", async () => {
    state.createReversal.mockImplementationOnce(() => { throw new Error("Stripe API timeout"); });
    state.commissionsTable[0] = {
      id: "cm_rev_fail", status: "disputed", promoter_id: "p_rev", order_id: "o_rev",
      commission_amount: 5000, dispute_id: "dp_rev", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_rev",
    };
    state.constructEvent.mockReturnValue({
      id: "evt_rev_fail",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_rev", status: "lost", metadata: { commissionId: "cm_rev_fail" } } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    // Status stayed 'disputed' — we did NOT flip to 'reversed'.
    expect(state.commissionsTable[0].status).toBe("disputed");
    expect(state.commissionsTable[0].dispute_closed_at).toBeNull();
    // reversal_failed audit row written.
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "commission_reversal_failed",
      actorId: SYSTEM_WEBHOOK_ACTOR_ID,
      targetId: "cm_rev_fail",
    }));
    // Ops email fired with commission + transfer info.
    expect(notifyAdminDisputeReversalFailed).toHaveBeenCalledWith({
      commissionId: "cm_rev_fail",
      transferId: "tr_rev",
      error: expect.stringContaining("Stripe API timeout"),
    });
    // Did NOT send the "resolved" email — the dispute is still open.
    expect(notifyAdminDisputeResolved).not.toHaveBeenCalled();
  });

  // R1 final review Fix 4: the dispute.closed UPDATE must include a
  // .in("status", ["disputed"]) guard so a re-delivered event (or a
  // concurrent admin resolve) cannot flip a row that was already
  // settled. We assert this by seeding the row as already-resolved
  // (status: 'paid') — the webhook must NOT touch it.
  it("UPDATE with .in('status', ['disputed']) guard: skips rows no longer in 'disputed' (Fix 4)", async () => {
    state.commissionsTable[0] = {
      id: "cm_race", status: "paid", // already settled; guard must reject
      promoter_id: "p_race", order_id: "o_race",
      commission_amount: 5000, dispute_id: "dp_race", dispute_status: "open",
      dispute_closed_at: null, paid_at: "2026-08-01T00:00:00Z", stripe_transfer_id: "tr_race",
    };
    state.constructEvent.mockReturnValue({
      id: "evt_race_lost",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_race", status: "lost", metadata: { commissionId: "cm_race" } } },
    });
    const req = { headers: { "stripe-signature": "t=1,v1=abc" }, body: Buffer.from("{}") } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn() } as any;
    await handleStripeWebhook(req, res);
    // Guard rejected — no status change, no audit row, no admin email.
    expect(state.commissionsTable[0].status).toBe("paid");
    expect(state.commissionsTable[0].dispute_status).toBe("open");
    expect(state.commissionsTable[0].dispute_closed_at).toBeNull();
    const resolveCalls = (writeAuditLog as any).mock.calls.filter(
      (c: any[]) => c[0]?.action === "commission_dispute_resolve",
    );
    expect(resolveCalls).toHaveLength(0);
    expect(notifyAdminDisputeResolved).not.toHaveBeenCalled();
    // The reversal still gets attempted (the guard only blocks the UPDATE).
    expect(state.createReversal).toHaveBeenCalledWith("tr_race", expect.any(Object));
  });
});
