import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { selfRegister } from "./register.controller.js";

export const registerRouter = Router();

// KOL must be signed in to register (so we can verify email matches the JWT).
registerRouter.use(kolAuthMiddleware);
registerRouter.post("/", selfRegister);
