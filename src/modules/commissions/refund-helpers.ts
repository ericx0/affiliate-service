export interface RefundDeductionInput {
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
  const refundPercentage = (input.refundAmount / input.orderAmount) * 100;
  const deductAmount = (input.commissionAmount * input.refundAmount) / input.orderAmount;
  const newCommissionAmount = input.commissionAmount - deductAmount;
  return {
    deductAmount: Math.round(deductAmount * 100) / 100,  // round to 2 decimals
    newCommissionAmount: Math.round(newCommissionAmount * 100) / 100,
    refundPercentage,
  };
}

export function shouldAutoReverse(input: { wasPaid: boolean; refundPercentage: number }): boolean {
  return input.wasPaid && input.refundPercentage >= 100;
}