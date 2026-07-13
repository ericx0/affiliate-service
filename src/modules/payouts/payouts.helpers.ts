export const MINIMUM_PAYOUT_AMOUNT = 50;  // USD

export interface CommissionForPayout {
  id: string;
  promoter_id: string;
  commission_amount: number;
  currency: string;
}

export interface PromoterPayoutGroup {
  promoterId: string;
  currency: string;
  total: number;
  commissionIds: string[];
}

export function groupCommissionsByPromoter(commissions: CommissionForPayout[]): Map<string, PromoterPayoutGroup> {
  const groups = new Map<string, PromoterPayoutGroup>();

  for (const c of commissions) {
    const existing = groups.get(c.promoter_id);
    if (existing) {
      existing.total += c.commission_amount;
      existing.commissionIds.push(c.id);
    } else {
      groups.set(c.promoter_id, {
        promoterId: c.promoter_id,
        currency: c.currency,
        total: c.commission_amount,
        commissionIds: [c.id],
      });
    }
  }

  // Totals are now in cents (integer), no rounding needed.
  for (const group of groups.values()) {
    group.total = Math.round(group.total);
  }

  return groups;
}

export function exceedsMinimum(amount: number, currency: string): boolean {
  // Only USD threshold defined for now; for other currencies, always payout
  if (currency === "USD") return amount >= MINIMUM_PAYOUT_AMOUNT;
  return true;
}