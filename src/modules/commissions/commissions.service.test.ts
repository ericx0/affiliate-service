import { describe, it, expect, vi, beforeEach } from "vitest";
import { canTransition } from "./commissions.types.js";
import { agentCommissionType } from "./commissions.service.js";

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
