import { stripe, supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { transition } from "../commissions/commissions.service.js";
import { groupCommissionsByPromoter, exceedsMinimum } from "./payouts.helpers.js";

export interface PayoutResult {
  success: boolean;
  transferId?: string;
  totalAmount?: number;
  commissionIds?: string[];
  error?: string;
}

/**
 * Pay out a single commission via Stripe Transfer to promoter's Connect account.
 */
export async function paySingleCommission(commissionId: string): Promise<PayoutResult> {
  // Fetch commission + promoter stripe_account_id
  const { data: commission, error } = await supabase
    .from("commissions")
    .select("*, promoters(stripe_account_id, stripe_onboarding_completed)")
    .eq("id", commissionId)
    .single();

  if (error || !commission) {
    return { success: false, error: "Commission not found" };
  }

  if (commission.status !== "approved") {
    return { success: false, error: `Cannot pay commission in status: ${commission.status}` };
  }

  const promoter = commission.promoters as any;
  if (!promoter?.stripe_account_id || !promoter.stripe_onboarding_completed) {
    return { success: false, error: "Promoter Stripe Connect not set up" };
  }

  const amountCents = Math.round(commission.commission_amount * 100);

  try {
    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: commission.currency.toLowerCase(),
      destination: promoter.stripe_account_id,
      metadata: {
        commissionId: commission.id,
        promoterId: commission.promoter_id,
        type: "affiliate_commission",
      },
    });

    // Transition to paid
    const result = await transition(commission.id, "paid", {
      stripe_transfer_id: transfer.id,
      stripe_payout_date: new Date().toISOString(),
      month_key: new Date().toISOString().slice(0, 7),  // YYYY-MM
    });

    if (!result.success) {
      logger.error({ commissionId, transferId: transfer.id }, "transfer succeeded but DB transition failed — manual fix needed");
      return { success: false, error: "DB transition failed" };
    }

    logger.info({ commissionId, transferId: transfer.id, amount: commission.commission_amount }, "commission paid");
    return { success: true, transferId: transfer.id, totalAmount: commission.commission_amount, commissionIds: [commission.id] };
  } catch (err) {
    logger.error({ err, commissionId }, "Stripe transfer failed");
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Pay out multiple approved commissions, grouped by promoter + currency.
 * Skips groups below minimum threshold (carries over to next month).
 */
export async function payCommissions(commissionIds: string[]): Promise<PayoutResult[]> {
  const { data: commissions, error } = await supabase
    .from("commissions")
    .select("*, promoters(stripe_account_id, stripe_onboarding_completed)")
    .in("id", commissionIds)
    .eq("status", "approved");

  if (error || !commissions) {
    return [{ success: false, error: "Failed to fetch commissions" }];
  }

  const groups = groupCommissionsByPromoter(commissions as any);
  const results: PayoutResult[] = [];

  for (const group of groups.values()) {
    if (!exceedsMinimum(group.total, group.currency)) {
      logger.info({ promoterId: group.promoterId, total: group.total, currency: group.currency }, "below minimum, carrying over");
      results.push({ success: false, error: "Below minimum threshold", commissionIds: group.commissionIds });
      continue;
    }

    // Pay first commission, rest in metadata
    const firstResult = await paySingleCommission(group.commissionIds[0]);
    if (firstResult.success && group.commissionIds.length > 1) {
      // For grouped payouts, we need to update remaining commissions with same transfer_id
      await supabase
        .from("commissions")
        .update({
          stripe_transfer_id: firstResult.transferId,
          paid_at: new Date().toISOString(),
          month_key: new Date().toISOString().slice(0, 7),
          updated_at: new Date().toISOString(),
        })
        .in("id", group.commissionIds.slice(1));

      firstResult.totalAmount = group.total;
      firstResult.commissionIds = group.commissionIds;
    }
    results.push(firstResult);
  }

  return results;
}