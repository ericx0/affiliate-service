import { Router } from "express";
import { agentAuthMiddleware } from "../../middleware/agent-auth.js";
import {
  createKol,
  listKols,
  getKol,
  getKolCommissions,
  suspendKol,
  activateKol,
  updateKol,
  getMyCommissions,
  getMyStats,
} from "./agents.controller.js";

export const agentRouter = Router();

// All agent endpoints require an authenticated session whose auth_user_id
// maps to a promoter with role='agent'. See agentAuthMiddleware.
agentRouter.use(agentAuthMiddleware);

agentRouter.post("/kols", createKol);
agentRouter.get("/kols", listKols);
agentRouter.get("/kols/:id", getKol);
agentRouter.get("/kols/:id/commissions", getKolCommissions);
agentRouter.post("/kols/:id/suspend", suspendKol);
agentRouter.post("/kols/:id/activate", activateKol);
agentRouter.patch("/kols/:id", updateKol);
agentRouter.get("/commissions", getMyCommissions);
agentRouter.get("/stats", getMyStats);
