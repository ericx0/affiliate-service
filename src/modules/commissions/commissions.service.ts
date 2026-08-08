import { z } from "zod";
import { affiliateSupabase, stripe } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  notifyKolCommissionPending,
  notifyKolCommissionReversed,
} from "../notifications/notifications.service.js";
import {
  Commission,
  CommissionStatus,
  CommissionType,
  CreateCommissionInput,
  TransitionResult,
  VALID_TRANSITIONS,
} from "./commissions.types.js";

// Published Commission Rules promise a 30-day cooling-off period before
// commission becomes payable (absorbs refund / chargeback risk). The code
// previously used 7 days, contradicting the policy.
const COOL_DOWN_DAYS = 30;

export const AttachOrderSchema = z.object({
  orderId: z.string().uuid(),
  promoterId: z.string().uuid(),
  commissionType: z.enum(["service", "subscription", "agent_service", "agent_subscription"]),
  orderAmount: z.number().positive(),
  commissionRate: z.number().min(0).max(50),
  currency: z.string().default("USD"),
});

/**
 * Map a KOL commission type to the corresponding agent override type.
 * Returns null for agent_* types - two-tier only, no override-of-override.
 */
export function agentCommissionType(kolType: CommissionType): CommissionType | null {
  switch (kolType) {
    case "service": return "agent_service";
    case "subscription": return "agent_subscription";
    default: return null;
  }
}

/**
 * Attach an order to a promoter. Creates a commission record in 'pending' state.
 * Idempotent: returns existing commission if order already attached.
 */
export async function attachToOrder(input: CreateCommissionInput): Promise<TransitionResult> {
  const validated = AttachOrderSchema.parse(input);

  // Check for existing commission
  const { data: existing } = await affiliateSupabase.from("commissions")
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

  const { data, error } = await affiliateSupabase.from("commissions")
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
      const { data: raced } = await affiliateSupabase.from("commissions")
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

  const { data, error } = await affiliateSupabase.from("commissions")
    .update(updates)
    .eq("id", commissionId)
    .in("status", validSources)
    .select()
    .single();

  if (error || !data) {
    // Either the row doesn't exist or its current status isn't in
    // validSources (already moved by a concurrent caller). Distinguish so
    // the caller can decide whether to retry.
    const { data: existing } = await affiliateSupabase.from("commissions")
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

  // Task 3.2: KOL email hooks on terminal-ish transitions.
  // Fire-and-forget — the .catch() inside the helper already logs;
  // awaiting here would block the business flow on Resend latency.
  void fireCommissionTransitionEmail(data as Commission, toStatus);

  return { success: true, commission: data as Commission };
}

/**
 * Best-effort post-transition email. Each branch is wrapped so a thrown
 * promise (DB read / Resend 5xx) doesn't bubble up into the caller —
 * notifications must NEVER fail a commission state change.
 */
async function fireCommissionTransitionEmail(
  commission: Commission,
  toStatus: CommissionStatus,
): Promise<void> {
  try {
    if (toStatus !== "approved") return; // only commission_pending for now
    const { data: promoter } = await affiliateSupabase
      .from("promoters")
      .select("email, name")
      .eq("id", commission.promoter_id)
      .maybeSingle();
    const p = promoter as { email: string; name: string } | null;
    if (!p?.email) return;
    // commission_amount is stored in cents (BIGINT); convert to dollars
    // for the email body per Task 3.2 convention ("amount is dollars
    // in notification templates, no /100 math in templates").
    await notifyKolCommissionPending({
      email: p.email,
      name: p.name,
      amount: commission.commission_amount / 100,
      currency: commission.currency,
      orderId: commission.order_id,
      promoterId: commission.promoter_id,
    });
  } catch (e) {
    logger.error({ err: (e as Error).message, commissionId: commission.id }, "fireCommissionTransitionEmail threw");
  }
}

/**
 * Approve all commissions whose cool-down has expired and are still in cooling_down state.
 * Called by daily cron job.
 */
export async function approveExpiredCooldowns(): Promise<number> {
  const { data: expired, error } = await affiliateSupabase.from("commissions")
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
 *
 * Partial-reversal aware: caller passes `amount` (in the same unit as
 * `commission_amount`) and an `eventId` scoped idempotency key so multiple
 * partial reversals (different events) don't collide. Does NOT auto-transition
 * to "reversed" -- the caller (Task 4 onOrderRefunded) decides terminal state
 * based on cumulative refunded amount.
 */
export async function reversePaidCommission(
  commissionId: string,
  amount: number,
  reason: string,
  eventId: string,
): Promise<TransitionResult> {
  const { data: commission, error } = await affiliateSupabase.from("commissions")
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
    // Partial reversal: amount passed by caller (deductAmount for partial,
    // remaining commission_amount for full). Idempotency key scoped by eventId
    // so multiple partial reversals (different events) don't collide.
    await stripe.transfers.createReversal(
      commission.stripe_transfer_id,
      {
        amount,
        metadata: { commissionId, reason, eventId },
      },
      { idempotencyKey: `commission-reverse-${commissionId}-${eventId}` },
    );
    // 不自动 transition -- 调用方按累计退款决定状态(reversed 仅在累计退满时)

    // Task 3.2: KOL email hook on successful reversal. Fire-and-forget;
    // cents → dollars for the email body per Task 3.2 convention.
    void fireReversalEmail(commission, commissionId, amount, reason).catch((e) =>
      logger.error({ err: (e as Error).message, commissionId }, "fireReversalEmail threw"),
    );

    return { success: true, commission: commission as Commission };
  } catch (err) {
    logger.error({ err, commissionId, eventId }, "failed to reverse Stripe transfer");
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Best-effort post-reversal email. Same contract as
 * fireCommissionTransitionEmail — the helper catches its own errors,
 * but we wrap in fire-and-forget + a logger guard so a thrown promise
 * here never reaches the caller of reversePaidCommission.
 */
async function fireReversalEmail(
  commission: { promoter_id: string; currency: string },
  commissionId: string,
  amountCents: number,
  reason: string,
): Promise<void> {
  try {
    const { data: promoter } = await affiliateSupabase
      .from("promoters")
      .select("email, name")
      .eq("id", commission.promoter_id)
      .maybeSingle();
    const p = promoter as { email: string; name: string } | null;
    if (!p?.email) return;
    await notifyKolCommissionReversed({
      email: p.email,
      name: p.name,
      amount: amountCents / 100,
      currency: commission.currency,
      orderId: commissionId,
      reason,
      promoterId: commission.promoter_id,
    });
  } catch (e) {
    logger.error({ err: (e as Error).message, commissionId }, "fireReversalEmail inner threw");
  }
}
