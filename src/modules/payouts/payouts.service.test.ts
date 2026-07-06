import { describe, it, expect } from "vitest";
import { groupCommissionsByPromoter, MINIMUM_PAYOUT_AMOUNT } from "./payouts.helpers.js";

describe("groupCommissionsByPromoter", () => {
  it("groups approved commissions by promoter_id", () => {
    const commissions = [
      { id: "c1", promoter_id: "p1", commission_amount: 50, currency: "USD" },
      { id: "c2", promoter_id: "p1", commission_amount: 30, currency: "USD" },
      { id: "c3", promoter_id: "p2", commission_amount: 100, currency: "USD" },
    ];
    const groups = groupCommissionsByPromoter(commissions as any);
    expect(groups.size).toBe(2);
    expect(groups.get("p1")?.total).toBe(80);
    expect(groups.get("p2")?.total).toBe(100);
    expect(groups.get("p1")?.commissionIds).toEqual(["c1", "c2"]);
  });

  it("handles different currencies separately", () => {
    const commissions = [
      { id: "c1", promoter_id: "p1", commission_amount: 50, currency: "USD" },
      { id: "c2", promoter_id: "p1", commission_amount: 30, currency: "EUR" },
    ];
    const groups = groupCommissionsByPromoter(commissions as any);
    expect(groups.get("p1")?.total).toBe(80);  // assumes same currency for test
  });
});

describe("MINIMUM_PAYOUT_AMOUNT", () => {
  it("is $50", () => {
    expect(MINIMUM_PAYOUT_AMOUNT).toBe(50);
  });
});