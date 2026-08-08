export type CommissionStatus =
  | "cooling_down"
  | "pending"
  | "approved"
  | "paid"
  | "refunded"
  | "reversed"
  | "voided"
  | "disputed";

export type CommissionType = "service" | "subscription" | "agent_service" | "agent_subscription";

export interface Commission {
  id: string;
  promoter_id: string;
  order_id: string;
  commission_type: CommissionType;
  order_amount: number;
  commission_rate: number;
  commission_amount: number;
  currency: string;
  status: CommissionStatus;
  service_completed_at: string | null;
  cool_down_until: string | null;
  approved_at: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  // Cumulative refunded order amount in CENTS (matches order_amount unit).
  cumulative_refunded_amount: number;
  stripe_transfer_id: string | null;
  month_key: string | null;
  // Dispute lifecycle (Task 1). Set by charge.dispute.* webhook.
  disputed_at: string | null;
  dispute_id: string | null;
  dispute_status: "open" | "won" | "lost" | null;
  dispute_closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCommissionInput {
  promoterId: string;
  orderId: string;
  commissionType: CommissionType;
  orderAmount: number;
  commissionRate: number;
  currency?: string;
  orderPaidAt?: Date;
}

export interface TransitionResult {
  success: boolean;
  commission?: Commission;
  error?: string;
}

// State transition table. 'disputed' is new in Task 1.
//
// Resolution matrix (from webhook charge.dispute.closed, see Task 2):
//   disputed + won  + paid_at NOT NULL → paid     (re-credit paid state)
//   disputed + won  + paid_at NULL     → approved (un-freeze)
//   disputed + lost + paid_at NOT NULL → reversed (claw back via Stripe)
//   disputed + lost + paid_at NULL     → voided   (cancel pending)
export const VALID_TRANSITIONS: Record<CommissionStatus, CommissionStatus[]> = {
  cooling_down: ["approved", "refunded", "voided", "disputed"],
  pending:      ["cooling_down", "refunded", "voided", "disputed"],
  approved:     ["paid", "refunded", "voided", "disputed"],
  paid:         ["reversed", "disputed"],
  refunded:     [],
  reversed:     [],
  voided:       [],
  // Idempotent re-fire keeps status='disputed'; resolution paths above.
  disputed:     ["approved", "paid", "reversed", "voided", "disputed"],
};

export function canTransition(from: CommissionStatus, to: CommissionStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
