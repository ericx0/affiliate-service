import { Router } from "express";
import { resendNotification } from "./notifications.controller.js";

export const notificationsRouter = Router();

// POST /admin/notifications/:id/resend — admin-only (mounted under
// adminRouter which already enforces adminAuthMiddleware).
notificationsRouter.post("/:id/resend", resendNotification);