import { Router } from "express";
export const ordersRouter = Router();

ordersRouter.post("/attach", (_req, res) => res.status(501).json({ error: "Not implemented" }));
ordersRouter.post("/events/order-paid", (_req, res) => res.status(501).json({ error: "Not implemented" }));
ordersRouter.post("/events/order-completed", (_req, res) => res.status(501).json({ error: "Not implemented" }));
ordersRouter.post("/events/order-refunded", (_req, res) => res.status(501).json({ error: "Not implemented" }));
ordersRouter.get("/:orderId/promoter", (_req, res) => res.status(501).json({ error: "Not implemented" }));