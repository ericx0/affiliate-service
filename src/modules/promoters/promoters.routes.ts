import { Router } from "express";
import { adminAuthMiddleware } from "../../middleware/admin-auth.js";
import { createPromoter } from "./promoters.controller.js";

export const promotersRouter = Router();

// Admin creates KOL via this endpoint — requires Supabase JWT (admin auth)
promotersRouter.use(adminAuthMiddleware);

promotersRouter.post("/", createPromoter);
