import { RequestHandler } from "express";

// Stub — full implementation in Task 1.9
export const hmacMiddleware: RequestHandler = (_req, _res, next) => {
  // TODO: verify X-LCM-Signature header against LCM_AFFILIATE_SECRET
  next();
};