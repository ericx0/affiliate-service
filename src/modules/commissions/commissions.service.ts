import { z } from "zod";
import { supabase, stripe } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  Commission,
  CommissionStatus,
  CreateCommissionInput,
  TransitionResult,
  VALID_TRANSITIONS,
} from "./commissions.types.js";

const COOL_DOWN_DAYS = 7;

export const AttachOrderSchema = z.object({
  orderId: z.string().uuid(),
  promoterId: z.string().uuid(),
  commissionType: z.enum(["service", "subscription"]),
  orderAmount: z.number().positive(),
  commissionRate: z.number().min(0).max(50),
  currency: z.string().default("USD"),
});

/**
 * Attach an order to a promoter. Creates a commission record in 'pending' state.
 * Idempotent: returns existing commission if order already attached.
 */
export async function attachToOrder(input: CreateCommissionInput): Promise<TransitionResult> {
  const validated = AttachOrderSchema.parse(input);

  // Check for existing commission
  const { data: existing } = await supabase
    .from("commissions")
    .select("*")
    .eq("order_id", validated.orderId)
    .eq("commission_type", validated.commissionType)
    .single();

  if (existing) {
    logger.info({ orderId: validated.orderId }, "commission already exists, returning existing");
    return { success: true, commission: existing as Commission };
  }

  // Cents: integer math, rounding to handle non-integer rate * order.
  const commissionAmount = Math.round(
    (validated.orderAmount * validated.commissionRate) / 100,
  );

  const { data, error } = await supabase
    .from("commissions")
    .insert({
      promoter_id: validated.promoterId,
      order_id: validated.orderId,
      commission_type: validated.commissionType,
      order_amount: validated.orderAmount,
      commission_rate: validated.commissionRate,
      commission_amount: commissionAmount,
      currency: validated.currency,
      status: "pending" as CommissionStatus,
    })
    .select()
    .single();

  if (error) {
    // A concurrent insert won the race and tripped the
    // UNIQUE(order_id, commission_type) constraint. Treat as idempotent:
    // fetch and return the row the other request created.
    if (error.code === "23505") {
      const { data: raced } = await supabase
        .from("commissions")
        .select("*")
        .eq("order_id", validated.orderId)
        .eq("commission_type", validated.commissionType)
        .single();
      if (raced) {
        return { success: true, commission: raced as Commission };
      }
    }
    logger.error({ error, input }, "failed to create commission");
    return { success: false, error: error.message };
  }

  logger.info({ commissionId: data.id, orderId: validated.orderId }, "commission attached");
  return { success: true, commission: data as Commission };
}

/**
 * Transition a commission to a new status. Validates state machine.
 *
 * ATOMIC: uses a conditional UPDATE that requires the current status to be
 * one of the valid predecessors of `toStatus`. If a concurrent transition
 * (or retry) has already moved the row, the affected-row count is 0 and we
 * report failure — never overwriting the new state.
 */
export async function transition(
  commissionId: string,
  toStatus: CommissionStatus,
  metadata: Record<string, any> = {}
): Promise<TransitionResult> {
  // Invert VALID_TRANSITIONS to find all states from which `toStatus` is
  // reachable in one step.
  const validSources = (Object.entries(VALID_TRANSITIONS) as [CommissionStatus, CommissionStatus[]][])
    .filter(([, targets]) => targets.includes(toStatus))
    .map(([from]) => from);

  if (validSources.length === 0) {
    return { success: false, error: `No valid source state for ${toStatus}` };
  }

  const now = new Date().toISOString();
  const updates: any = { status: toStatus, updated_at: now, ...metadata };

  // Add timestamp for terminal-ish states
  if (toStatus === "cooling_down" && metadata.service_completed_at) {
    const completedAt = new Date(metadata.service_completed_at);
    const coolDownEnd = new Date(completedAt);
    coolDownEnd.setDate(coolDownEnd.getDate() + COOL_DOWN_DAYS);
    updates.service_completed_at = completedAt.toISOString();
    updates.cool_down_until = coolDownEnd.toISOString();
  }
  if (toStatus === "approved") updates.approved_at = now;
  if (toStatus === "paid") updates.paid_at = now;
  if (toStatus === "refunded") updates.refunded_at = now;
  if (toStatus === "reversed") updates.refunded_at = now;  // reuse field for reverse

  const { data, error } = await supabase
    .from("commissions")
    .update(updates)
    .eq("id", commissionId)
    .in("status", validSources)
    .select()
    .single();

  if (error || !data) {
    // Either the row doesn't exist or its current status isn't in
    // validSources (already moved by a concurrent caller). Distinguish so
    // the caller can decide whether to retry.
    const { data: existing } = await supabase
      .from("commissions")
      .select("status")
      .eq("id", commissionId)
      .maybeSingle();
    if (!existing) {
      return { success: false, error: "Commission not found" };
    }
    logger.warn(
      { commissionId, attemptedTo: toStatus, currentStatus: existing.status },
      "commission transition rejected (concurrent or invalid state)",
    );
    return {
      success: false,
      error: `Cannot transition from ${existing.status} to ${toStatus}`,
    };
  }

  logger.info({ commissionId, to: toStatus }, "commission transitioned");
  return { success: true, commission: data as Commission };
}

/**
 * Approve all commissions whose cool-down has expired and are still in cooling_down state.
 * Called by daily cron job.
 */
export async function approveExpiredCooldowns(): Promise<number> {
  const { data: expired, error } = await supabase
    .from("commissions")
    .select("id")
    .eq("status", "cooling_down")
    .lte("cool_down_until", new Date().toISOString())
    .is("refunded_at", null);  // not refunded during cool-down

  if (error) {
    logger.error({ error }, "failed to fetch expired cooldowns");
    return 0;
  }

  let count = 0;
  for (const row of expired || []) {
    const result = await transition(row.id, "approved");
    if (result.success) count++;
  }

  logger.info({ approved: count, total: expired?.length || 0 }, "cool-down approvals complete");
  return count;
}

/**
 * Reverse a paid commission via Stripe Transfer reversal.
 * Used when a refund occurs after payout.
 */
export async function reversePaidCommission(
  commissionId: string,
  reason: string
): Promise<TransitionResult> {
  const { data: commission, error } = await supabase
    .from("commissions")
    .select("*")
    .eq("id", commissionId)
    .single();

  if (error || !commission) {
    return { success: false, error: "Commission not found" };
  }

  if (commission.status !== "paid" || !commission.stripe_transfer_id) {
    return { success: false, error: "Commission not paid or no Stripe transfer" };
  }

  try {
    // Reverse the Stripe transfer. Idempotency key prevents double-reversal
    // (e.g. retry of this endpoint after a transient failure between the
    // Stripe call and the DB transition) from withdrawing twice.
    await stripe.transfers.createReversal(
      commission.stripe_transfer_id,
      {
        amount: commission.commission_amount,  // already cents
        metadata: { commissionId, reason },
      },
      { idempotencyKey: `commission-reverse-${commissionId}` },
    );

    // Mark as reversed
    return await transition(commissionId, "reversed", { refund_reason: reason });
  } catch (err) {
    logger.error({ err, commissionId }, "failed to reverse Stripe transfer");
    return { success: false, error: (err as Error).message };
  }
}