import { Request, Response, NextFunction } from "express";

/**
 * Stub: accepts any role. Will be replaced in Phase 5 with real role enforcement
 * (checks Supabase admin_users table for role membership).
 */
export const requireRole = (_roles: string[]) => (_req: Request, _res: Response, next: NextFunction) => {
  next();
};