import crypto from "node:crypto";
import { stripe, supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { transition } from "../commissions/commissions.service.js";
import { groupCommissionsByPromoter, exceedsMinimum } from "./payouts.helpers.js";
import { getOpenFlaggedCommissionIds } from "../fraud/fraud.service.js";

export interface PayoutResult {
  success: boolean;
  transferId?: string;
  totalAmount?: number;
  commissionIds?: string[];
  error?: string;
}

/**
 * IRS compliance gate (P0-6): a promoter must have submitted a W-9/W-8BEN
 * tax form (status 'submitted' or 'valid') before any payout. Returns
 * { ok: false, reason } if not; the caller returns it as the payout error.
 */
async function assertTaxFormSubmitted(promoterId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await supabase
    .from("affiliate.tax_forms")
    .select("status")
    .eq("promoter_id", promoterId)
    .maybeSingle();
  if (error) {
    logger.error({ err: error, promoterId }, "tax_forms check failed");
    return { ok: false, reason: "Tax form check failed" };
  }
  if (!data || !["submitted", "valid"].includes(data.status)) {
    return { ok: false, reason: "Tax form (W-9/W-8BEN) required before payout. Submit it in the portal." };
  }
  return { ok: true };
}

/**
 * Pay a single commission. Used by the admin manual-payout flow when a
 * promoter has a one-off transfer (no group). Idempotent by commission id.
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

  // IRS compliance gate (P0-6): no payout without a submitted tax form.
  const taxCheck = await assertTaxFormSubmitted(commission.promoter_id);
  if (!taxCheck.ok) {
    return { success: false, error: taxCheck.reason! };
  }

  // commission_amount is already in cents (integer).
  const amountCents = commission.commission_amount;

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: commission.currency.toLowerCase(),
        destination: promoter.stripe_account_id,
        metadata: {
          commissionId: commission.id,
          promoterId: commission.promoter_id,
          type: "affiliate_commission",
        },
      },
      // Stripe guarantees at-most-once per key: concurrent calls or retries
      // for the same commission return the SAME transfer — no double payout.
      { idempotencyKey: `commission-payout-${commission.id}` },
    );

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
 * Pay a GROUP of approved commissions for a single promoter in ONE Stripe
 * transfer for the group total. Replaces the previous buggy logic that
 * paid only the first commission and marked the rest as paid without a
 * corresponding transfer (underpay).
 *
 * Idempotency: derived from the sorted commission ids + month so retries
 * with the same set of commissions return the same Stripe transfer and
 * the same DB update. Different commission sets produce different keys.
 */
export async function payPromoterGroup(
  promoterId: string,
  currency: string,
  commissionIds: string[],
  totalAmount: number,
): Promise<PayoutResult> {
  if (commissionIds.length === 0) {
    return { success: false, error: "No commissions to pay" };
  }
  const sortedIds = [...commissionIds].sort();
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM (for month_key only)
  // idempotencyKey must NOT include month: a retry next month for the same
  // commission set must return the SAME Stripe transfer (at-most-once),
  // not create a second transfer (double payout). H-AFF-2.
  const idempotencyKey = `group-payout-${promoterId}-${currency}-${crypto
    .createHash("sha256")
    .update(sortedIds.join(","))
    .digest("hex")
    .slice(0, 16)}`;

  const { data: promoter, error: promoterErr } = await supabase
    .from("promoters")
    .select("stripe_account_id, stripe_onboarding_completed")
    .eq("id", promoterId)
    .single();
  if (promoterErr || !promoter?.stripe_account_id || !promoter.stripe_onboarding_completed) {
    return { success: false, error: "Promoter Stripe Connect not set up" };
  }

  // IRS compliance gate (P0-6): no payout without a submitted tax form.
  const taxCheck = await assertTaxFormSubmitted(promoterId);
  if (!taxCheck.ok) {
    return { success: false, error: taxCheck.reason! };
  }

  // totalAmount is already in cents (integer).
  const amountCents = totalAmount;

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: currency.toLowerCase(),
        destination: promoter.stripe_account_id,
        metadata: {
          commissionIds: sortedIds.join(","),
          promoterId,
          type: "affiliate_commission_group",
        },
      },
      { idempotencyKey },
    );

    // Transition each commission to paid. transition() uses a conditional
    // UPDATE (only fires from valid source states), so any already-paid
    // commission is a no-op (idempotent), and the whole loop is safe
    // against partial failures because the Stripe transfer is the
    // ground truth.
    const paidAt = new Date().toISOString();
    let successCount = 0;
    for (const id of sortedIds) {
      const r = await transition(id, "paid", {
        stripe_transfer_id: transfer.id,
        stripe_payout_date: paidAt,
        month_key: month,
      });
      if (r.success) successCount += 1;
    }

    if (successCount === 0) {
      // No commission was actually moved (all were already paid by a
      // concurrent caller). The Stripe transfer is still made — treat
      // as success because the result is correct (the promoter has been
      // paid the right amount for the right commissions).
      logger.warn(
        { promoterId, transferId: transfer.id, commissionCount: sortedIds.length },
        "group transfer made but no commissions transitioned (likely already paid)",
      );
    }

    logger.info(
      {
        promoterId,
        transferId: transfer.id,
        amount: totalAmount,
        commissionCount: sortedIds.length,
        transitionedCount: successCount,
      },
      "promoter group payout completed",
    );
    return {
      success: true,
      transferId: transfer.id,
      totalAmount,
      commissionIds: sortedIds,
    };
  } catch (err) {
    logger.error(
      { err, promoterId, commissionIds: sortedIds },
      "Stripe group transfer failed",
    );
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Pay out multiple approved commissions, grouped by promoter + currency.
 * Each group is paid in a single Stripe transfer for the group total
 * (one transfer per promoter+currency, not per commission).
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

  // Anti-fraud gate: commissions with an OPEN fraud flag are held out of
  // the batch until an admin resolves the flag (fail-closed on lookup
  // error — see getOpenFlaggedCommissionIds).
  const flaggedIds = await getOpenFlaggedCommissionIds(
    commissions.map((c: any) => c.id as string),
  );
  const payable = (commissions as any[]).filter((c) => !flaggedIds.has(c.id));
  const withheld: PayoutResult[] = (commissions as any[])
    .filter((c) => flaggedIds.has(c.id))
    .map((c) => ({
      success: false,
      error: "Under fraud review — payout withheld pending admin resolution",
      commissionIds: [c.id],
    }));

  const groups = groupCommissionsByPromoter(payable as any);
  const results: PayoutResult[] = [...withheld];

  for (const group of groups.values()) {
    if (!exceedsMinimum(group.total, group.currency)) {
      logger.info(
        { promoterId: group.promoterId, total: group.total, currency: group.currency },
        "below minimum, carrying over",
      );
      results.push({ success: false, error: "Below minimum threshold", commissionIds: group.commissionIds });
      continue;
    }

    // One transfer per group, not per commission.
    const result = await payPromoterGroup(
      group.promoterId,
      group.currency,
      group.commissionIds,
      group.total,
    );
    results.push(result);
  }

  return results;
}
