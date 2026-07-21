import { Router } from "express";
import { kolAuthMiddleware, kolJwtMiddleware } from "../../middleware/kol-auth.js";
import { selfRegister } from "./register.controller.js";
import { syncKOLProfile } from "./sync.controller.js";

export const registerRouter = Router();

// KOL self-registration. JWT-only middleware (NOT kolAuthMiddleware):
// a new KOL has no promoter row yet, so requiring one 403s every signup.
// selfRegister itself enforces body.email/authUserId == JWT identity.
registerRouter.post("/", kolJwtMiddleware, selfRegister);

// AS-P1-8 followup: KOL signin path. Called by the client on every
// successful signin + on app foreground. Idempotent — only writes
// when a field actually changed. Requires an existing promoter row.
registerRouter.post("/sync", kolAuthMiddleware, syncKOLProfile);