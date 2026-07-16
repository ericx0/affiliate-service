import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { supabase } from "../../config.js";
import { attachToOrder, transition, agentCommissionType } from "../commissions/commissions.service.js";
import { Commission } from "../commissions/commissions.types.js";
import { internalError } from "../../utils/controller-error.js";

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
  const { data: promoter } = await supabase
    .from("affiliate.promoters")
    .select("commission_rate, status, recruited_by_agent_id")
    .eq("id", input.promoterId)
    .single();

  if (!promoter || promoter.status !== "active") {
    return res.status(400).json({ error: { code: "INVALID_PROMOTER", message: "Promoter not active" } });
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
    const { data: agent } = await supabase
      .from("affiliate.promoters")
      .select("commission_rate, status")
      .eq("id", agentId)
      .eq("role", "agent")
      .maybeSingle();

    if (agent && agent.status === "active") {
      const agentType = agentCommissionType(input.commissionType);
      if (agentType) {
        const agentResult = await attachToOrder({
          promoterId: agentId,
          orderId: input.orderId,
          commissionType: agentType,
          orderAmount: input.orderAmount,
          commissionRate: agent.commission_rate,
          currency: input.currency,
        });
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
  const { data } = await supabase
    .from("commissions")
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
    // Update order_paid_at; may stay in pending if service not yet completed
    await supabase
      .from("commissions")
      .update({ order_paid_at: paidAt, updated_at: new Date().toISOString() })
      .eq("id", c.id);
    count++;
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
    // Transition: pending → cooling_down (with 7-day cool-down)
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
  const { error: claimErr } = await supabase.from("affiliate.refund_events").insert({
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

  // 2. AS-P1-5: For now, only support FULL refunds. Partial refund
  //    requires cumulative tracking on commissions (cumulative_refunded
  //    column) that does not yet exist — would otherwise allow compound
  //    reduction on replay. Reject partial explicitly so callers know.
  const commissions = await getCommissionsForOrder(orderId);
  if (commissions.length === 0) {
    logger.info({ orderId }, "no commissions to refund");
    return res.json({ success: true, commissionsAffected: 0 });
  }

  const isPartial = commissions.some(
    (c) => refundAmount !== undefined && refundAmount < c.order_amount,
  );
  if (isPartial) {
    logger.warn(
      { orderId, refundAmount },
      "partial refund rejected — cumulative tracking not yet implemented",
    );
    return res.status(501).json({
      error: {
        code: "PARTIAL_REFUND_UNSUPPORTED",
        message: "Partial refunds require cumulative tracking migration; not yet implemented.",
      },
    });
  }

  let count = 0;
  for (const c of commissions) {
    // Idempotency at the commission level: skip rows already in a
    // terminal-refund state. transition() also enforces source-state
    // CAS, but the explicit skip is clearer and avoids an unnecessary
    // UPDATE round-trip.
    if (c.status === "refunded" || c.status === "reversed") continue;

    const result = await transition(c.id, "refunded", {
      refund_reason: reason || "Customer refund",
    });
    if (result.success) count++;
  }

  logger.info(
    { eventId, orderId, count, refundAmount },
    "order refunded event processed",
  );
  res.json({ success: true, commissionsAffected: count });
}

export async function getOrderPromoter(req: Request, res: Response) {
  const { orderId } = req.params;

  const { data: order } = await supabase
    .from("commissions")
    .select("promoter_id, status, commission_amount")
    .eq("order_id", orderId)
    .limit(1)
    .single();

  if (!order) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "No commission for this order" } });
  }

  res.json({ promoterId: order.promoter_id, status: order.status, commissionAmount: order.commission_amount });
}