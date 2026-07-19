import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupCommissionsByPromoter, MINIMUM_PAYOUT_AMOUNT, exceedsMinimum } from "./payouts.helpers.js";

// Mock the supabase and stripe imports so we can drive payPromoterGroup
// without hitting real services. We use vi.hoisted to expose shared state.
const mockState = vi.hoisted(() => ({
  stripeTransfersCreate: vi.fn(),
  promoterById: new Map<string, any>(),
  transitionResult: { success: true, commission: { id: "x" } as any },
  transitions: [] as Array<{ id: string; to: string; metadata: any }>,
}));

vi.mock("../../config.js", () => ({
  stripe: {
    transfers: {
      create: (...args: any[]) => mockState.stripeTransfersCreate(...args),
    },
  },
  supabase: {
    from: (table: string) => {
      if (table === "promoters") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              single: async () => {
                const p = mockState.promoterById.get(val);
                if (!p) return { data: null, error: { message: "not found" } };
                return { data: p, error: null };
              },
            }),
          }),
        };
      }
      throw new Error("unmocked table " + table);
    },
  },
}));

vi.mock("../commissions/commissions.service.js", () => ({
  transition: async (id: string, to: string, metadata: any) => {
    mockState.transitions.push({ id, to, metadata });
    return mockState.transitionResult;
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

import { payPromoterGroup } from "./payouts.service.js";

beforeEach(() => {
  mockState.stripeTransfersCreate.mockReset();
  mockState.promoterById.clear();
  mockState.transitions = [];
  mockState.promoterById.set("p1", {
    stripe_account_id: "acct_1",
    stripe_onboarding_completed: true,
  });
  mockState.stripeTransfersCreate.mockResolvedValue({ id: "tr_123" });
});

describe("payPromoterGroup — F29 regression", () => {
  it("creates ONE transfer for the group total (not per commission)", async () => {
    const result = await payPromoterGroup(
      "p1",
      "USD",
      ["c1", "c2", "c3"],
      24000, // group total in cents
    );
    expect(result.success).toBe(true);
    expect(mockState.stripeTransfersCreate).toHaveBeenCalledTimes(1);
    const [args, opts] = mockState.stripeTransfersCreate.mock.calls[0];
    expect(args.amount).toBe(24000); // cents (no *100)
    expect(args.destination).toBe("acct_1");
    expect(args.metadata.commissionIds).toBe("c1,c2,c3");
    expect(args.metadata.promoterId).toBe("p1");
    expect(opts.idempotencyKey).toContain("group-payout-p1-USD-");
  });

  it("transitions EVERY commission in the group to paid", async () => {
    await payPromoterGroup("p1", "USD", ["c1", "c2", "c3"], 24000);
    expect(mockState.transitions.length).toBe(3);
    expect(mockState.transitions.map((t) => t.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(mockState.transitions.every((t) => t.to === "paid")).toBe(true);
  });

  it("uses the same transfer id on all commission transitions", async () => {
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 8000);
    const transferIds = new Set(mockState.transitions.map((t) => t.metadata.stripe_transfer_id));
    expect(transferIds.size).toBe(1);
    expect(transferIds.has("tr_123")).toBe(true);
  });

  it("is idempotent: same commission set => same idempotency key", async () => {
    await payPromoterGroup("p1", "USD", ["c2", "c1"], 8000);
    const key1 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    mockState.stripeTransfersCreate.mockClear();
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 8000);
    const key2 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    expect(key1).toBe(key2);
  });

  it("different commission set => different idempotency key", async () => {
    await payPromoterGroup("p1", "USD", ["c1"], 4000);
    const key1 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    mockState.stripeTransfersCreate.mockClear();
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 8000);
    const key2 = mockState.stripeTransfersCreate.mock.calls[0][1].idempotencyKey;
    expect(key1).not.toBe(key2);
  });

  it("refuses promoter without Stripe Connect setup", async () => {
    mockState.promoterById.set("p2", {
      stripe_account_id: null,
      stripe_onboarding_completed: false,
    });
    const result = await payPromoterGroup("p2", "USD", ["c1"], 4000);
    expect(result.success).toBe(false);
    expect(mockState.stripeTransfersCreate).not.toHaveBeenCalled();
  });

  it("passes integer cents through unchanged", async () => {
    await payPromoterGroup("p1", "USD", ["c1", "c2"], 10000);
    expect(mockState.stripeTransfersCreate.mock.calls[0][0].amount).toBe(10000);
  });
});

describe("groupCommissionsByPromoter", () => {
  it("groups approved commissions by promoter_id (amounts in cents)", () => {
    const commissions = [
      { id: "c1", promoter_id: "p1", commission_amount: 5000, currency: "USD" },
      { id: "c2", promoter_id: "p1", commission_amount: 3000, currency: "USD" },
      { id: "c3", promoter_id: "p2", commission_amount: 10000, currency: "USD" },
    ];
    const groups = groupCommissionsByPromoter(commissions as any);
    expect(groups.size).toBe(2);
    expect(groups.get("p1")?.total).toBe(8000);
    expect(groups.get("p2")?.total).toBe(10000);
    expect(groups.get("p1")?.commissionIds).toEqual(["c1", "c2"]);
  });

  it("handles different currencies separately", () => {
    const commissions = [
      { id: "c1", promoter_id: "p1", commission_amount: 5000, currency: "USD" },
      { id: "c2", promoter_id: "p1", commission_amount: 3000, currency: "EUR" },
    ];
    const groups = groupCommissionsByPromoter(commissions as any);
    expect(groups.get("p1")?.total).toBe(8000);
  });
});

describe("exceedsMinimum", () => {
  it("USD $50 threshold (amounts in cents)", () => {
    expect(exceedsMinimum(5000, "USD")).toBe(true);
    expect(exceedsMinimum(4999, "USD")).toBe(false);
  });
  it("non-USD always passes (no threshold defined)", () => {
    expect(exceedsMinimum(1, "EUR")).toBe(true);
  });
});

describe("MINIMUM_PAYOUT_AMOUNT", () => {
  it("is $50 in cents", () => {
    expect(MINIMUM_PAYOUT_AMOUNT).toBe(5000);
  });
});
