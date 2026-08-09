import { Router } from "express";
import {
  attach,
  onOrderPaid,
  onOrderCompleted,
  onOrderRefunded,
  onOrderDisputed,
  onOrderDisputeResolved,
  getOrderPromoter,
} from "./orders.controller.js";

export const ordersRouter = Router();

ordersRouter.post("/attach", attach);
ordersRouter.post("/events/order-paid", onOrderPaid);
ordersRouter.post("/events/order-completed", onOrderCompleted);
ordersRouter.post("/events/order-refunded", onOrderRefunded);
// Internal dispute event endpoints. Reached by linkchinamed-web via the
// HMAC bridge after it receives the original Stripe charge.dispute.* event.
ordersRouter.post("/events/order-disputed", onOrderDisputed);
ordersRouter.post("/events/order-dispute-resolved", onOrderDisputeResolved);
ordersRouter.get("/:orderId/promoter", getOrderPromoter);