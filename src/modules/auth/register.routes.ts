import { Router } from "express";
import { kolAuthMiddleware } from "../../middleware/kol-auth.js";
import { selfRegister } from "./register.controller.js";
import { syncKOLProfile } from "./sync.controller.js";

export const registerRouter = Router();

// KOL must be signed in to register (so we can verify email matches the JWT).
registerRouter.use(kolAuthMiddleware);
registerRouter.post("/", selfRegister);

// AS-P1-8 followup: KOL signin path. Called by the client on every
// successful signin + on app foreground. Idempotent — only writes
// when a field actually changed.
registerRouter.post("/sync", syncKOLProfile);