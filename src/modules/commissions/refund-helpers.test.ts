import { describe, it, expect } from "vitest";
import { calculateRefundDeduction, shouldAutoReverse } from "./refund-helpers.js";

describe("calculateRefundDeduction cumulative", () => {
  it("first partial refund 50%", () => {
    const r = calculateRefundDeduction({ orderAmount: 1000, commissionAmount: 100, refundAmount: 500 });
    expect(r.deductAmount).toBe(50);
    expect(r.newCommissionAmount).toBe(50);
    expect(r.refundPercentage).toBe(50);
  });
  it("full refund gives deduct=commission", () => {
    const r = calculateRefundDeduction({ orderAmount: 1000, commissionAmount: 100, refundAmount: 1000 });
    expect(r.deductAmount).toBe(100);
    expect(r.newCommissionAmount).toBe(0);
    expect(r.refundPercentage).toBe(100);
  });
  it("integer cent math, no drift", () => {
    const r = calculateRefundDeduction({ orderAmount: 333, commissionAmount: 33, refundAmount: 111 });
    expect(Number.isInteger(r.deductAmount)).toBe(true);
    expect(Number.isInteger(r.newCommissionAmount)).toBe(true);
  });
});

describe("shouldAutoReverse", () => {
  it("reverses when paid AND 100% refunded", () => {
    expect(shouldAutoReverse({ wasPaid: true, refundPercentage: 100 })).toBe(true);
  });
  it("does not reverse at 99%", () => {
    expect(shouldAutoReverse({ wasPaid: true, refundPercentage: 99 })).toBe(false);
  });
  it("does not reverse unpaid", () => {
    expect(shouldAutoReverse({ wasPaid: false, refundPercentage: 100 })).toBe(false);
  });
});