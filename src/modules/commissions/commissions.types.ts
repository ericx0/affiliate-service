export type CommissionStatus =
  | "cooling_down"
  | "pending"
  | "approved"
  | "paid"
  | "refunded"
  | "reversed";

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

// State transition table (spec section 6.2)
export const VALID_TRANSITIONS: Record<CommissionStatus, CommissionStatus[]> = {
  cooling_down: ["approved", "refunded"],
  pending: ["cooling_down", "refunded"],
  approved: ["paid", "refunded"],
  paid: ["reversed"],
  refunded: [],   // terminal
  reversed: [],   // terminal
};

export function canTransition(from: CommissionStatus, to: CommissionStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}