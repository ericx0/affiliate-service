import { describe, it, expect } from "vitest";
import { calculateRefundDeduction, shouldAutoReverse } from "./refund-helpers.js";

describe("calculateRefundDeduction", () => {
  it("returns 0 commission deduction for partial refund < 50%", () => {
    const result = calculateRefundDeduction({
      orderAmount: 1000,
      commissionAmount: 50,
      refundAmount: 400,  // 40% refund
    });
    expect(result.deductAmount).toBe(20);  // 40% of $50
    expect(result.newCommissionAmount).toBe(30);
  });

  it("returns full commission for 100% refund", () => {
    const result = calculateRefundDeduction({
      orderAmount: 1000,
      commissionAmount: 50,
      refundAmount: 1000,
    });
    expect(result.deductAmount).toBe(50);
    expect(result.newCommissionAmount).toBe(0);
  });

  it("handles multiple partial refunds", () => {
    const first = calculateRefundDeduction({
      orderAmount: 1000,
      commissionAmount: 50,
      refundAmount: 200,  // 20% first refund
    });
    const second = calculateRefundDeduction({
      orderAmount: 800,  // after first refund
      commissionAmount: first.newCommissionAmount,
      refundAmount: 200,  // 25% second refund of remaining
    });
    expect(second.newCommissionAmount).toBeCloseTo(30, 0);  // 50 * 0.8 * 0.75 = 30
  });

  it("rounds to 2 decimals for dollar amounts with cents", () => {
    // commission 49.99, order 200.00, refund 50.00 (25%)
    // deduct = 49.99 * 50 / 200 = 12.4975 -> 12.50 (2-decimal round)
    const result = calculateRefundDeduction({
      orderAmount: 200,
      commissionAmount: 49.99,
      refundAmount: 50,
    });
    expect(result.deductAmount).toBe(12.50);
    expect(result.newCommissionAmount).toBe(37.49);
  });
});

describe("shouldAutoReverse", () => {
  it("returns true if commission was paid and refund is full", () => {
    expect(shouldAutoReverse({ wasPaid: true, refundPercentage: 100 })).toBe(true);
  });

  it("returns false if commission was not paid", () => {
    expect(shouldAutoReverse({ wasPaid: false, refundPercentage: 100 })).toBe(false);
  });

  it("returns false for partial refund even if paid", () => {
    expect(shouldAutoReverse({ wasPaid: true, refundPercentage: 50 })).toBe(false);
  });
});