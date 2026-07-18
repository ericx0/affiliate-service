export interface RefundDeductionInput {
  // All amounts are in dollars (NUMERIC(12,2), 2-decimal rounding).
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
  // Dollar math with 2-decimal rounding (matches commissions table NUMERIC(12,2)).
  // refundPercentage is the only non-rounded output (it's a percentage).
  const refundPercentage = (input.refundAmount / input.orderAmount) * 100;
  const deductAmount = Math.round(
    ((input.commissionAmount * input.refundAmount) / input.orderAmount) * 100,
  ) / 100;
  const newCommissionAmount = Math.round(
    (input.commissionAmount - deductAmount) * 100,
  ) / 100;
  return {
    deductAmount,
    newCommissionAmount,
    refundPercentage,
  };
}

export function shouldAutoReverse(input: { wasPaid: boolean; refundPercentage: number }): boolean {
  return input.wasPaid && input.refundPercentage >= 100;
}