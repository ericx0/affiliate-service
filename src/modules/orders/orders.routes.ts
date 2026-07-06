import { Router } from "express";
import { attach, onOrderPaid, onOrderCompleted, onOrderRefunded, getOrderPromoter } from "./orders.controller.js";

export const ordersRouter = Router();

ordersRouter.post("/attach", attach);
ordersRouter.post("/events/order-paid", onOrderPaid);
ordersRouter.post("/events/order-completed", onOrderCompleted);
ordersRouter.post("/events/order-refunded", onOrderRefunded);
ordersRouter.get("/:orderId/promoter", getOrderPromoter);