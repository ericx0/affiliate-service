import { Router } from "express";
import { listNotifications, resendNotification } from "./notifications.controller.js";

export const notificationsRouter = Router();

// GET /admin/notifications — admin-only notification log listing.
// (mounted under adminRouter which already enforces adminAuthMiddleware)
notificationsRouter.get("/", listNotifications);

// POST /admin/notifications/:id/resend — admin-only manual resend.
notificationsRouter.post("/:id/resend", resendNotification);