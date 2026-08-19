import { describe, it, expect, vi, beforeEach } from "vitest";
import { canTransition } from "./commissions.types.js";
import { agentCommissionType, COOL_DOWN_DAYS, transition } from "./commissions.service.js";

// Shared mutable state so each reversePaidCommission negative-path test can
// stage different commission rows + Stripe errors without re-initializing the
// module mock. vi.hoisted runs before vi.mock factories are evaluated.
const { state } = vi.hoisted(() => ({
  state: {
    commission: {
      id: "c1", status: "paid", stripe_transfer_id: "tr_123",
      commission_amount: 100, order_amount: 2000,
      cumulative_refunded_amount: 0,
    } as Record<string, any> | null,
    stripeError: null as Error | null,
    // F-AFF-PAYOUT-7: cool-down transition tests stage a commission
    // row in 'cooling_down' (or 'pending') and the matching promoter
    // row for the post-transition email helper. transition() merges
    // service_completed_at -> cool_down_until, so we capture the
    // merged commission from .update() arguments.
    transitionCommission: null as Record<string, any> | null,
    transitionPromoter: null as Record<string, any> | null,
    lastTransitionUpdate: null as Record<string, any> | null,
  },
}));

// Mock supabase + stripe for reversePaidCommission tests.
// vi.mock is hoisted by vitest to before all imports, so the mocked
// config module is in place when commissions.service.ts loads.
vi.mock("../../config.js", () => ({
  env: {
    LOG_LEVEL: "warn",
    NODE_ENV: "test",
  },
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: state.commission,
            error: state.commission ? null : { code: "PGRST116", message: "no rows" },
          })),
        })),
      })),
    })),
  },
  // commissions.service.ts queries affiliate.* tables via this client.
  affiliateSupabase: {
    from: (table: string) => {
      // F-AFF-PAYOUT-7: transition() needs update().eq().in().select().single()
      // for the commission row, plus select().eq().maybeSingle() for the
      // promoter email lookup. Build a self-returning chain that captures
      // the update payload and dispatches the right leaf method.
      const chain: any = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.update = (row: Record<string, any>) => {
        state.lastTransitionUpdate = row;
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: table === "promoters" ? state.transitionPromoter : null,
        error: null,
      });
      chain.single = async () => {
        // If the test staged a transitionCommission, merge the captured
        // update payload so the caller sees cool_down_until populated.
        if (table === "commissions" && state.transitionCommission) {
          return {
            data: { ...state.transitionCommission, ...(state.lastTransitionUpdate ?? {}) },
            error: null,
          };
        }
        return {
          data: state.commission,
          error: state.commission ? null : { code: "PGRST116", message: "no rows" },
        };
      };
      return chain;
    },
  },
  stripe: {
    transfers: {
      createReversal: vi.fn(async () => {
        if (state.stripeError) throw state.stripeError;
        return { id: "trr_1" };
      }),
    },
  },
}));

describe("commission state machine", () => {
  it("cooling_down -> approved is valid", () => {
    expect(canTransition("cooling_down", "approved")).toBe(true);
  });

  it("cooling_down -> refunded is valid", () => {
    expect(canTransition("cooling_down", "refunded")).toBe(true);
  });

  it("approved -> paid is valid", () => {
    expect(canTransition("approved", "paid")).toBe(true);
  });

  it("paid -> reversed is valid", () => {
    expect(canTransition("paid", "reversed")).toBe(true);
  });

  it("pending -> cooling_down is valid (after order paid)", () => {
    expect(canTransition("pending", "cooling_down")).toBe(true);
  });

  it("refunded -> paid is INVALID (terminal state)", () => {
    expect(canTransition("refunded", "paid")).toBe(false);
  });

  it("paid -> cooling_down is INVALID (no going back)", () => {
    expect(canTransition("paid", "cooling_down")).toBe(false);
  });

  it("approved -> cooling_down is INVALID", () => {
    expect(canTransition("approved", "cooling_down")).toBe(false);
  });
});

describe("agentCommissionType", () => {
  it("maps 'service' to 'agent_service'", () => {
    expect(agentCommissionType("service")).toBe("agent_service");
  });

  it("maps 'subscription' to 'agent_subscription'", () => {
    expect(agentCommissionType("subscription")).toBe("agent_subscription");
  });

  it("returns null for agent_* (no override-of-override, two-tier only)", () => {
    expect(agentCommissionType("agent_service")).toBeNull();
    expect(agentCommissionType("agent_subscription")).toBeNull();
  });
});

describe("reversePaidCommission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.commission = {
      id: "c1", status: "paid", stripe_transfer_id: "tr_123",
      commission_amount: 100, order_amount: 2000,
      cumulative_refunded_amount: 0,
    };
    state.stripeError = null;
  });

  it("calls Stripe with passed amount + eventId-scoped idempotency key, no transition", async () => {
    const { reversePaidCommission } = await import("./commissions.service.js");
    const result = await reversePaidCommission("c1", 12.50, "partial refund", "evt_001");
    expect(result.success).toBe(true);
    const { stripe } = await import("../../config.js");
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_123",
      expect.objectContaining({ amount: 12.50, metadata: expect.objectContaining({ eventId: "evt_001" }) }),
      { idempotencyKey: "commission-reverse-c1-evt_001" },
    );
  });

  it("returns failure when commission is not found", async () => {
    state.commission = null;
    const { reversePaidCommission } = await import("./commissions.service.js");
    const result = await reversePaidCommission("c_missing", 10, "refund", "evt_002");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Commission not found");
    const { stripe } = await import("../../config.js");
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("returns failure when status is not 'paid'", async () => {
    state.commission = {
      id: "c2", status: "cooling_down", stripe_transfer_id: "tr_456",
      commission_amount: 100, order_amount: 2000,
      cumulative_refunded_amount: 0,
    };
    const { reversePaidCommission } = await import("./commissions.service.js");
    const result = await reversePaidCommission("c2", 10, "refund", "evt_003");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Commission not paid or no Stripe transfer");
    const { stripe } = await import("../../config.js");
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("returns failure when stripe_transfer_id is missing", async () => {
    state.commission = {
      id: "c3", status: "paid", stripe_transfer_id: null,
      commission_amount: 100, order_amount: 2000,
      cumulative_refunded_amount: 0,
    };
    const { reversePaidCommission } = await import("./commissions.service.js");
    const result = await reversePaidCommission("c3", 10, "refund", "evt_004");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Commission not paid or no Stripe transfer");
    const { stripe } = await import("../../config.js");
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("returns failure when Stripe createReversal throws", async () => {
    state.stripeError = new Error("Stripe API error: rate limited");
    const { reversePaidCommission } = await import("./commissions.service.js");
    const result = await reversePaidCommission("c1", 10, "refund", "evt_005");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Stripe API error: rate limited");
    const { stripe } = await import("../../config.js");
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_123",
      expect.objectContaining({ amount: 10, metadata: expect.objectContaining({ eventId: "evt_005" }) }),
      { idempotencyKey: "commission-reverse-c1-evt_005" },
    );
  });
});

// F-AFF-PAYOUT-7: explicit coverage that the 30-day cool-down window
// applies to ALL commission types — agent_service / agent_subscription
// share the same threshold as KOL service / subscription. Catches a
// regression where someone introduces a per-type COOL_DOWN_DAYS (e.g.
// "agents get 7 days") or silently flips it back to 7.
describe("COOL_DOWN_DAYS — uniform across all commission types", () => {
  it("is exported and pinned to 30 days", () => {
    expect(COOL_DOWN_DAYS).toBe(30);
  });

  it("transition() computes cool_down_until as service_completed_at + 30 days for agent_service", async () => {
    state.lastTransitionUpdate = null;
    state.transitionCommission = {
      id: "c_agent_svc", promoter_id: "p_agent", commission_type: "agent_service",
      status: "pending", commission_amount: 500, currency: "USD",
      order_id: "o_1",
    };
    state.transitionPromoter = { email: null, name: null, role: "agent" };
    const completedAt = "2026-07-01T00:00:00.000Z";
    const result = await transition(
      "c_agent_svc", "cooling_down", { service_completed_at: completedAt },
    );
    expect(result.success).toBe(true);
    const coolDownUntil = (result.commission as { cool_down_until?: string }).cool_down_until;
    expect(coolDownUntil).toBeDefined();
    const expected = new Date(completedAt);
    expected.setUTCDate(expected.getUTCDate() + 30);
    expect(new Date(coolDownUntil!).toISOString()).toBe(expected.toISOString());
  });

  it("transition() computes cool_down_until as service_completed_at + 30 days for agent_subscription", async () => {
    state.lastTransitionUpdate = null;
    state.transitionCommission = {
      id: "c_agent_sub", promoter_id: "p_agent", commission_type: "agent_subscription",
      status: "pending", commission_amount: 1200, currency: "USD",
      order_id: "o_2",
    };
    state.transitionPromoter = { email: null, name: null, role: "agent" };
    const completedAt = "2026-06-15T12:00:00.000Z";
    const result = await transition(
      "c_agent_sub", "cooling_down", { service_completed_at: completedAt },
    );
    expect(result.success).toBe(true);
    const coolDownUntil = (result.commission as { cool_down_until?: string }).cool_down_until;
    const expected = new Date(completedAt);
    expected.setUTCDate(expected.getUTCDate() + 30);
    expect(new Date(coolDownUntil!).toISOString()).toBe(expected.toISOString());
  });

  it("transition() applies the same 30-day window to KOL service (parity with agent)", async () => {
    state.lastTransitionUpdate = null;
    state.transitionCommission = {
      id: "c_kol", promoter_id: "p_kol", commission_type: "service",
      status: "pending", commission_amount: 700, currency: "USD",
      order_id: "o_3",
    };
    state.transitionPromoter = { email: null, name: null, role: "kol" };
    const completedAt = "2026-05-01T00:00:00.000Z";
    const result = await transition(
      "c_kol", "cooling_down", { service_completed_at: completedAt },
    );
    expect(result.success).toBe(true);
    const coolDownUntil = (result.commission as { cool_down_until?: string }).cool_down_until;
    const expected = new Date(completedAt);
    expected.setUTCDate(expected.getUTCDate() + 30);
    expect(new Date(coolDownUntil!).toISOString()).toBe(expected.toISOString());
  });
});
