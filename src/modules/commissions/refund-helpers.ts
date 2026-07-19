export interface RefundDeductionInput {
  // All amounts are integer CENTS (matches affiliate.commissions columns:
  // order_amount / commission_amount are BIGINT cents since migration
  // 20260713000002; cumulative_refunded_amount is BIGINT cents too).
  orderAmount: number;
  commissionAmount: number;
  refundAmount: number;
}

export interface RefundDeductionResult {
  deductAmount: number;
  newCommissionAmount: number;
  refundPercentage: number;
}

export function calculateRefundDeduction(input: RefundDeductionInput): RefundDeductionResult {
  // Integer-cent math: no float drift, and the result can be passed
  // straight to Stripe (transfer reversal amounts are integer cents).
  // refundPercentage is the only non-integer output (it's a percentage).
  const refundPercentage = (input.refundAmount / input.orderAmount) * 100;
  const deductAmount = Math.round(
    (input.commissionAmount * input.refundAmount) / input.orderAmount,
  );
  const newCommissionAmount = input.commissionAmount - deductAmount;
  return {
    deductAmount,
    newCommissionAmount,
    refundPercentage,
  };
}

export function shouldAutoReverse(input: { wasPaid: boolean; refundPercentage: number }): boolean {
  return input.wasPaid && input.refundPercentage >= 100;
}
