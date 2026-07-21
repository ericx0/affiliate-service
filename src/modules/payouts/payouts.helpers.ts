// Minimum payout threshold in CENTS ($50.00). commission_amount /
// group.total are integer cents (BIGINT since migration 010), so the
// threshold must be compared in the same unit.
export const MINIMUM_PAYOUT_AMOUNT = 5000;

// Approximate USD 50 equivalents per currency, per the published policy
// "$50 (or equivalent)". Static approximations pending FX-driven
// thresholds; unknown currencies conservatively require >= 5000 minor units.
const MINIMUM_PAYOUT_BY_CURRENCY: Record<string, number> = {
  USD: 5000,
  EUR: 4600,
  GBP: 4000,
  JPY: 7500,
};

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
    // Key by promoter_id + currency: a promoter with commissions in
    // multiple currencies gets a separate payout group per currency (P1 -
    // otherwise the second currency's amount would be paid under the first
    // currency's Stripe transfer).
    const key = `${c.promoter_id}:${c.currency}`;
    const existing = groups.get(key);
    if (existing) {
      existing.total += c.commission_amount;
      existing.commissionIds.push(c.id);
    } else {
      groups.set(key, {
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
  // "$50 or equivalent" per the published Commission Rules — previously
  // only USD had a threshold and any non-USD balance paid out regardless
  // of size, inviting fee-erosion micropayouts.
  return amount >= (MINIMUM_PAYOUT_BY_CURRENCY[currency] ?? 5000);
}