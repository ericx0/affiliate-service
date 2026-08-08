import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { getCodeQr } from "./codes.controller.js";

export const codesRouter = Router();

codesRouter.use(kolAuthMiddleware);
codesRouter.get("/me/codes/:codeId/qr", getCodeQr);