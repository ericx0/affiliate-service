import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { getMyFunnel } from "./funnel.controller.js";

export const funnelRouter = Router();

funnelRouter.use(kolAuthMiddleware);

funnelRouter.get("/", getMyFunnel);
