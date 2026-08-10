import { Router } from "express";
import { checkEmail } from "./check-email.controller.js";

export const checkEmailRouter: Router = Router();

// Public endpoint — no JWT required (used to check if a login attempt
// is even valid before signInWithOtp). Cloudflare edge rate limit
// gates enumeration. Turnstile token is required per request.
checkEmailRouter.get("/check-email", checkEmail);
