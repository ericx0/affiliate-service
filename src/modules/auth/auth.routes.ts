import { Router } from "express";
import { adminAuthMiddleware } from "../../middleware/admin-auth.js";
import { setupTotp, verifyTotpSetup, disableTotp, getTotpStatus } from "./auth.controller.js";

export const adminAuthRouter = Router();

// All admin auth routes require valid Supabase JWT (no HMAC needed)
adminAuthRouter.use(adminAuthMiddleware);

adminAuthRouter.get("/2fa/status", getTotpStatus);
adminAuthRouter.post("/2fa/setup", setupTotp);
adminAuthRouter.post("/2fa/verify", verifyTotpSetup);
adminAuthRouter.post("/2fa/disable", disableTotp);
