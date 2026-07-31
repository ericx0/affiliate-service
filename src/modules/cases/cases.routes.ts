import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { getCase, listCases, rewriteCase } from "./cases.controller.js";

export const casesRouter = Router();

// Cases browsing is open to any logged-in KOL (RLS already restricts
// reads to is_published=true). The AI rewrite endpoint is rate-limited
// upstream because it costs tokens.
casesRouter.use(kolAuthMiddleware);

casesRouter.get("/", listCases);
casesRouter.get("/:id", getCase);
casesRouter.post("/:id/rewrite", rewriteCase);
