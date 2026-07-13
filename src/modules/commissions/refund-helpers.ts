export interface RefundDeductionInput {
  // All amounts are in cents (integer).
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
  // Integer-cents math. refundPercentage is the only non-integer output
  // (it's a percentage, not a money amount).
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