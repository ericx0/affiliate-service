import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { supabase } from "../../config.js";
import { attachToOrder, transition } from "../commissions/commissions.service.js";
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

  // Look up promoter commission_rate
  const { data: promoter } = await supabase
    .from("promoters")
    .select("commission_rate, status")
    .eq("id", input.promoterId)
    .single();

  if (!promoter || promoter.status !== "active") {
    return res.status(400).json({ error: { code: "INVALID_PROMOTER", message: "Promoter not active" } });
  }

  const result = await attachToOrder({
    promoterId: input.promoterId,
    orderId: input.orderId,
    commissionType: input.commissionType,
    orderAmount: input.orderAmount,
    commissionRate: promoter.commission_rate,
    currency: input.currency,
  });

  if (!result.success) {
    return internalError(res, "ATTACH_FAILED", result)
  }

  res.json({ success: true, commission: result.commission });
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
  const { error: claimErr } = await supabase.from("refund_events").insert({
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