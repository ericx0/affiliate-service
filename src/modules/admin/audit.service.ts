import { logger } from "../../utils/logger.js";

export interface AuditLogInput {
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  beforeState?: unknown;
  afterState?: unknown;
  reason?: string;
}

/**
 * Stub: just logs to stdout. Will be replaced in Phase 5 to write to
 * Supabase audit_logs table.
 */
export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  logger.info({ audit: input }, "audit log");
}