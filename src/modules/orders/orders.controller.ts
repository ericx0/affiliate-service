import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { affiliateSupabase, stripe } from "../../config.js";
import {
  attachToOrder,
  transition,
  agentCommissionType,
  reversePaidCommission,
} from "../commissions/commissions.service.js";
import { calculateRefundDeduction } from "../commissions/refund-helpers.js";
import { Commission } from "../commissions/commissions.types.js";
import { checkSelfReferral } from "../fraud/fraud.service.js";
import { internalError } from "../../utils/controller-error.js";
import {
  notifyKolDisputed,
  notifyAdminDispute,
  notifyAdminDisputeResolved,
  notifyAdminDisputeReversalFailed,
} from "../notifications/notifications.service.js";
import { writeAuditLog } from "../admin/audit.service.js";

// Sentinel UUID for audit rows written by the internal dispute endpoint
// (no human actor — must satisfy NOT NULL UUID on audit_logs.target_id and
// actor_id). Mirrors stripe-webhook.controller.ts.
const SYSTEM_INTERNAL_ACTOR_ID = "00000000-0000-0000-0000-000000000002";

const AttachSchema = z.object({
  orderId: z.string().uuid(),
  promoterId: z.string().uuid(),
  orderAmount: z.number().positive(),
  commissionType: z.enum(["service", "subscription"]).default("service"),
  currency: z.string().default("USD"),
});

export async function attach(req: Request, res: Response) {
  const input = AttachSchema.parse(req.body);

  // Look up promoter (KOL) commission_rate + recruited_by_agent_id
  const { data: promoter } = await affiliateSupabase.from("promoters")
    .select("commission_rate, status, recruited_by_agent_id")
    .eq("id", input.promoterId)
    .single();

  if (!promoter || promoter.status !== "active") {
    return res.status(400).json({ error: { code: "INVALID_PROMOTER", message: "Promoter not active" } });
  }

  // L1 anti-fraud (Code of Conduct §3 / Commission Rules §6): a promoter
  // buying through their own referral link is a self-referral — block the
  // attach, raise a fraud flag for admin review, and return success so the
  // customer's order flow is never affected.
  const fraudCheck = await checkSelfReferral(input.promoterId, input.orderId);
  if (fraudCheck.flagged) {
    return res.json({ success: true, flagged: true, flagType: fraudCheck.flagType, commission: null, agentCommission: null });
  }

  // 1. Attach the primary (KOL) commission.
  const result = await attachToOrder({
    promoterId: input.promoterId,
    orderId: input.orderId,
    commissionType: input.commissionType,
    orderAmount: input.orderAmount,
    commissionRate: promoter.commission_rate,
    currency: input.currency,
  });

  if (!result.success) {
    return internalError(res, "ATTACH_FAILED", result);
  }

  // 2. Two-tier split: if this KOL was recruited by an agent, attach an
  //    override commission for the agent. Uses a distinct commission_type
  //    ('agent_service' / 'agent_subscription') so UNIQUE(order_id,
  //    commission_type) allows both rows. Failure here MUST NOT block the
  //    KOL commission - log and surface a partial result.
  let agentCommission: Commission | null = null;
  const agentId = promoter.recruited_by_agent_id;
  if (agentId) {
    const { data: agent } = await affiliateSupabase.from("promoters")
      .select("commission_rate, status")
      .eq("id", agentId)
      .eq("role", "agent")
      .maybeSingle();

    if (agent && agent.status === "active") {
      const agentType = agentCommissionType(input.commissionType);
      if (agentType) {
        // Agent commission rate is DYNAMIC: auto-tier by the agent's current
        // active recruited KOL count (5/8/10% via affiliate.compute_agent_tier),
        // NOT the static commission_rate set at creation. Fall back to the
        // stored rate only if the function is unavailable.
        const { data: tierRows } = await affiliateSupabase.rpc("compute_agent_tier", {
          p_agent_id: agentId,
        });
        const tierRow = Array.isArray(tierRows) ? tierRows[0] : tierRows;
        const agentRate =
          tierRow && tierRow.rate != null
            ? Number(tierRow.rate)
            : agent.commission_rate;
        if (!tierRow || tierRow.rate == null) {
          logger.warn(
            { agentId },
            "compute_agent_tier returned no rate; falling back to stored commission_rate",
          );
        }

        let agentResult: { success: boolean; commission?: Commission | null; error?: string };
        try {
          agentResult = await attachToOrder({
            promoterId: agentId,
            orderId: input.orderId,
            commissionType: agentType,
            orderAmount: input.orderAmount,
            commissionRate: agentRate,
            currency: input.currency,
          });
        } catch (e) {
          // Express 4 does not auto-catch async rejections - without this
          // try/catch a throw here hangs the whole request (KOL commission
          // already attached, but the response never sends).
          logger.error(
            { orderId: input.orderId, agentId, error: (e as Error).message },
            "agent override commission attach threw; KOL commission still attached",
          );
          agentResult = { success: false, error: (e as Error).message };
        }
        if (agentResult.success) {
          agentCommission = agentResult.commission ?? null;
        } else {
          logger.error(
            { orderId: input.orderId, agentId, error: agentResult.error },
            "agent override commission attach failed; KOL commission still attached",
          );
        }
      }
    } else {
      logger.warn({ orderId: input.orderId, agentId }, "agent not active or not found; override skipped");
    }
  }

  res.json({ success: true, commission: result.commission, agentCommission });
}

const OrderEventSchema = z.object({
  orderId: z.string().uuid(),
  occurredAt: z.string().datetime().optional(),
  reason: z.string().optional(),
  refundAmount: z.number().nonnegative().optional(),
});

const RefundEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  orderId: z.string().uuid(),
  reason: z.string().optional(),
  refundAmount: z.number().nonnegative().optional(),
});

async function getCommissionsForOrder(orderId: string) {
  const { data } = await affiliateSupabase.from("commissions")
    .select("*")
    .eq("order_id", orderId);
  return data || [];
}

export async function onOrderPaid(req: Request, res: Response) {
  const { orderId, occurredAt } = OrderEventSchema.parse(req.body);
  const paidAt = occurredAt || new Date().toISOString();

  const commissions = await getCommissionsForOrder(orderId);
  let count = 0;

  for (const c of commissions) {
    // Idempotency: order_paid_at is write-once. A replayed/duplicate
    // delivery (main-site webhook + edge function both call this) finds
    // the column already set and skips; the CAS predicate
    // (.is order_paid_at null) makes concurrent duplicates no-ops too.
    // Terminal rows (refunded/reversed) are never touched.
    if (c.order_paid_at || c.status === "refunded" || c.status === "reversed") continue;
    const { error } = await affiliateSupabase.from("commissions")
      .update({ order_paid_at: paidAt, updated_at: new Date().toISOString() })
      .eq("id", c.id)
      .is("order_paid_at", null);
    if (!error) count++;
  }

  logger.info({ orderId, count }, "order paid event processed");
  res.json({ success: true, commissionsUpdated: count });
}

export async function onOrderCompleted(req: Request, res: Response) {
  const { orderId, occurredAt } = OrderEventSchema.parse(req.body);
  const completedAt = occurredAt || new Date().toISOString();

  const commissions = await getCommissionsForOrder(orderId);
  let count = 0;

  for (const c of commissions) {
    // Transition: pending → cooling_down (with 30-day cool-down per the
    // published Commission Rules).
    // Idempotent under duplicate delivery: only rows still in 'pending'
    // are touched, and transition() is a CAS update gated on the current
    // status, so replays and concurrent duplicates are no-ops.
    if (c.status === "pending") {
      const result = await transition(c.id, "cooling_down", {
        service_completed_at: completedAt,
      });
      if (result.success) count++;
    }
  }

  logger.info({ orderId, count }, "order completed event processed");
  res.json({ success: true, commissionsCooled: count });
}

export async function onOrderRefunded(req: Request, res: Response) {
  const { eventId, orderId, reason, refundAmount } = RefundEventSchema.parse(req.body);

  // 1. Idempotency: atomically claim the eventId. Conflict = already
  //    processed this event — return success without re-applying.
  const { error: claimErr } = await affiliateSupabase.from("refund_events").insert({
    event_id: eventId,
    order_id: orderId,
    refund_amount: refundAmount ?? null,
    reason: reason ?? null,
  });
  if (claimErr) {
    if (claimErr.code === "23505") {
      logger.info({ eventId, orderId }, "refund event already processed");
      return res.json({ success: true, duplicate: true });
    }
    logger.error({ err: claimErr, eventId }, "refund event claim failed");
    return internalError(res, "REFUND_EVENT_CLAIM_FAILED", { message: claimErr.message });
  }

  // 2. Partial-refund aware: process each commission with proportional
  //    deduction. refundAmount undefined = full refund. Cumulative tracking
  //    via cumulative_refunded_amount prevents compound reduction on replay.
  const commissions = await getCommissionsForOrder(orderId);
  if (commissions.length === 0) {
    logger.info({ orderId }, "no commissions to refund");
    return res.json({ success: true, commissionsAffected: 0 });
  }

  let count = 0;
  for (const c of commissions) {
    // Skip terminal-refund rows (idempotency at commission level).
    if (c.status === "refunded" || c.status === "reversed") continue;

    // clamp: effective refund = min(refundAmount, remaining). Undefined = full.
    const orderAmount = Number(c.order_amount);
    const alreadyRefunded = Number(c.cumulative_refunded_amount);
    const remaining = orderAmount - alreadyRefunded;
    const effectiveRefund = refundAmount !== undefined
      ? Math.min(refundAmount, remaining)
      : orderAmount;
    if (effectiveRefund <= 0) continue;  // already fully refunded

    const { deductAmount, newCommissionAmount } = calculateRefundDeduction({
      orderAmount,
      commissionAmount: Number(c.commission_amount),
      refundAmount: effectiveRefund,
    });

    // paid status: reverse the Stripe transfer (partial). On failure, roll
    // back the refund_events claim for this eventId and return 500 so Stripe
    // retries the webhook. Commissions reversed earlier in this loop keep
    // their DB updates (CAS by status protects them on retry); the failed
    // commission retries via its eventId-scoped Stripe idempotency key.
    if (c.status === "paid" && c.stripe_transfer_id) {
      const rev = await reversePaidCommission(
        c.id, deductAmount, reason || "Customer refund", eventId,
      );
      if (!rev.success) {
        logger.error(
          { commissionId: c.id, eventId, error: rev.error },
          "Stripe reversal failed; rolling back refund_events claim and returning 500 for webhook retry",
        );
        await affiliateSupabase.from("refund_events")
          .delete()
          .eq("event_id", eventId);
        return internalError(
          res,
          "STRIPE_REVERSAL_FAILED",
          { eventId, commissionId: c.id, error: rev.error },
          { eventId, commissionId: c.id },
        );
      }
    }

    const newCumulative = alreadyRefunded + effectiveRefund;
    const isFullyRefunded = newCumulative >= orderAmount;

    if (isFullyRefunded) {
      // Cumulative refund reached order_amount: transition to terminal.
      // paid -> reversed (payout was reversed above); others -> refunded.
      const targetStatus = c.status === "paid" ? "reversed" : "refunded";
      const result = await transition(c.id, targetStatus, {
        refund_reason: reason || "Customer refund",
        commission_amount: newCommissionAmount,
        cumulative_refunded_amount: newCumulative,
      });
      if (result.success) count++;
    } else {
      // Partial refund: keep status, only adjust amounts (CAS: status match).
      const { error: updErr } = await affiliateSupabase.from("commissions")
        .update({
          commission_amount: newCommissionAmount,
          cumulative_refunded_amount: newCumulative,
          updated_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .in("status", [c.status]);
      if (!updErr) count++;
    }
  }

  logger.info({ eventId, orderId, count, refundAmount }, "order refunded event processed");
  res.json({ success: true, commissionsAffected: count });
}

export async function getOrderPromoter(req: Request, res: Response) {
  const { orderId } = req.params;

  const { data: order } = await affiliateSupabase.from("commissions")
    .select("promoter_id, status, commission_amount")
    .eq("order_id", orderId)
    .limit(1)
    .single();

  if (!order) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "No commission for this order" } });
  }

  res.json({ promoterId: order.promoter_id, status: order.status, commissionAmount: order.commission_amount });
}

// DisputeEmitSchema (linkchinamed-web/src/lib/affiliate-service.ts).
// These endpoints exist because customer payment disputes hit the main
// platform's Stripe webhook (linkchinamed-web), not affiliate-service's.
// Forwarding via HMAC bridge lets affiliate-service freeze / resolve
// commissions using the orderId it already understands.
const OrderDisputedSchema = z.object({
  disputeId: z.string().min(1).max(200),
  orderId: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(10),
  reason: z.string().min(1).max(200),
  status: z.string().min(1).max(50),
});

const OrderDisputeResolvedSchema = z.object({
  disputeId: z.string().min(1).max(200),
  orderId: z.string().uuid(),
  outcome: z.enum(["won", "lost", "warning_closed"]),
});

export async function onOrderDisputed(req: Request, res: Response) {
  const { disputeId, orderId, reason } = OrderDisputedSchema.parse(req.body);

  const commissions = await getCommissionsForOrder(orderId);
  if (commissions.length === 0) {
    logger.info({ orderId, disputeId }, "no commissions for disputed order");
    return res.json({ success: true, commissionsFrozen: 0 });
  }

  const now = new Date().toISOString();
  let count = 0;

  for (const c of commissions) {
    // Idempotent on disputeId: if this commission already records this
    // dispute, skip. Partial unique index on dispute_id also enforces
    // this at the DB level.
    if (c.dispute_id === disputeId) continue;
    // Already in a terminal dispute state — don't re-freeze.
    if (c.dispute_status === "open") continue;

    const { error: updErr } = await affiliateSupabase.from("commissions")
      .update({
        status: "disputed",
        disputed_at: now,
        dispute_id: disputeId,
        dispute_status: "open",
        updated_at: now,
      })
      .eq("id", c.id);
    if (updErr) {
      logger.error(
        { err: updErr, commissionId: c.id, disputeId },
        "commission freeze UPDATE failed",
      );
      throw updErr;
    }
    count++;

    await writeAuditLog({
      actorId: SYSTEM_INTERNAL_ACTOR_ID,
      actorEmail: "system@order-dispute-emit",
      action: "commission_dispute_freeze",
      targetType: "commission",
      targetId: c.id,
      afterState: { dispute_id: disputeId, status: "disputed" },
      reason: `stripe_dispute=${disputeId}; reason=${reason}; emit_from=linkchinamed-web`,
    });

    // commission_amount is stored as integer cents (migration 20260713000002);
    // convert at the cents→display boundary here.
    await notifyKolDisputed({
      promoterId: c.promoter_id,
      commissionId: c.id,
      amount: ((Number(c.commission_amount ?? 0)) / 100).toFixed(2),
      disputeReason: reason,
    }).catch((e) =>
      logger.error({ error: (e as Error).message }, "notifyKolDisputed failed"),
    );
  }

  // Best-effort ops alert (always, even when 0 commissions match — an
  // unmatched dispute still needs ops eyes).
  await notifyAdminDispute({
    commissionId: orderId,
    reason,
  }).catch((e) =>
    logger.error({ error: (e as Error).message }, "notifyAdminDispute failed"),
  );

  logger.info({ orderId, disputeId, count }, "order disputed event processed");
  res.json({ success: true, commissionsFrozen: count });
}

export async function onOrderDisputeResolved(req: Request, res: Response) {
  const { disputeId, orderId, outcome } = OrderDisputeResolvedSchema.parse(req.body);

  const commissions = await getCommissionsForOrder(orderId);
  if (commissions.length === 0) {
    logger.info({ orderId, disputeId }, "no commissions for dispute resolution");
    return res.json({ success: true, commissionsResolved: 0 });
  }

  const won = outcome === "won" || outcome === "warning_closed";
  const now = new Date().toISOString();
  let count = 0;

  for (const c of commissions) {
    if (c.dispute_id !== disputeId) continue;
    if (c.dispute_closed_at) continue; // idempotent

    const wasPaid = !!c.paid_at;
    let targetStatus: "approved" | "paid" | "reversed" | "voided";
    if (won) {
      targetStatus = wasPaid ? "paid" : "approved";
    } else {
      targetStatus = wasPaid ? "reversed" : "voided";
    }

    // Stripe transfer reversal FIRST for lost + paid. If it fails, leave
    // the commission in 'disputed' for manual ops follow-up — never flip
    // status to 'reversed' without money actually moving.
    if (!won && wasPaid && c.stripe_transfer_id) {
      try {
        await stripe.transfers.createReversal(
          c.stripe_transfer_id,
          {
            metadata: {
              commissionId: c.id,
              disputeId,
              reason: "dispute_lost",
            },
          },
          // commission-level idempotency key — collapses concurrent
          // re-attempts (webhook re-delivery / admin-v2 manual resolve
          // racing) into Stripe's idempotent response.
          { idempotencyKey: `commission-reversal-${c.id}` },
        );
      } catch (revErr) {
        const errMsg = (revErr as Error).message ?? String(revErr);
        await writeAuditLog({
          actorId: SYSTEM_INTERNAL_ACTOR_ID,
          actorEmail: "system@order-dispute-emit",
          action: "commission_reversal_failed",
          targetType: "commission",
          targetId: c.id,
          afterState: { transfer_id: c.stripe_transfer_id, status: "disputed" },
          reason: `stripe_dispute=${disputeId}; reversal_error=${errMsg}`,
        });
        await notifyAdminDisputeReversalFailed({
          commissionId: c.id,
          transferId: c.stripe_transfer_id,
          error: errMsg,
        }).catch((e) =>
          logger.error({ error: (e as Error).message }, "notifyAdminDisputeReversalFailed failed"),
        );
        // Skip the rest — commission stays 'disputed', ops gets a separate
        // alert (NOT a 'resolved' email).
        continue;
      }
    }

    // Conditional UPDATE — only flip if still in 'disputed'. Concurrent
    // admin resolve or duplicate emit otherwise drops the trail.
    const { data: updatedRows, error: updErr } = await affiliateSupabase
      .from("commissions")
      .update({
        status: targetStatus,
        dispute_status: won ? "won" : "lost",
        dispute_closed_at: now,
        updated_at: now,
        ...(won ? {} : { disputed_at: null }),
      })
      .eq("id", c.id)
      .in("status", ["disputed"])
      .select("id");
    if (updErr) throw updErr;

    const updateSucceeded = Array.isArray(updatedRows) && updatedRows.length > 0;

    await writeAuditLog({
      actorId: SYSTEM_INTERNAL_ACTOR_ID,
      actorEmail: "system@order-dispute-emit",
      action: "commission_dispute_resolve",
      targetType: "commission",
      targetId: c.id,
      afterState: {
        dispute_id: disputeId,
        status: targetStatus,
        outcome,
        update_succeeded: updateSucceeded,
      },
      reason: `stripe_dispute=${disputeId}; outcome=${outcome}; emit_from=linkchinamed-web`,
    });

    await notifyAdminDisputeResolved({
      commissionId: c.id,
      action: won ? "won" : "lost",
      note: `stripe_dispute=${disputeId}; outcome=${outcome}`,
    }).catch((e) =>
      logger.error({ error: (e as Error).message }, "notifyAdminDisputeResolved failed"),
    );

    count++;
  }

  logger.info({ orderId, disputeId, outcome, count }, "order dispute resolved event processed");
  res.json({ success: true, commissionsResolved: count });
}