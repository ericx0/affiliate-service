import { logger } from "../../utils/logger.js";
import { supabase } from "../../config.js";

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
 * Insert an audit row into affiliate.audit_logs (RLS-protected; only
 * service_role bypasses RLS for inserts).
 *
 * Best-effort: writes are awaited by callers but a failure here is
 * logged but does NOT throw — losing an audit row should not break
 * the user-facing admin action. Callers that need a hard guarantee
 * should check the return value.
 *
 * target_id is NOT NULL UUID in the schema; when the caller-provided
 * id is not a UUID we encode the original into the reason field and
 * store a sentinel UUID so the NOT NULL constraint is satisfied.
 */
export async function writeAuditLog(input: AuditLogInput): Promise<boolean> {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const targetIdIsUuid = uuidRegex.test(input.targetId);

  if (!targetIdIsUuid) {
    logger.warn(
      {
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
      },
      "audit log target_id is not a UUID; encoding into reason fallback",
    );
  }

  const row = {
    actor_id: input.actorId,
    actor_email: input.actorEmail,
    action: input.action,
    target_type: input.targetType,
    target_id: targetIdIsUuid
      ? input.targetId
      : "00000000-0000-0000-0000-000000000000",
    before_state: input.beforeState ?? null,
    after_state: input.afterState ?? null,
    reason:
      (input.reason ?? "") +
      (targetIdIsUuid
        ? ""
        : ` [non-uuid-target-id:${input.targetId}]`),
  };

  const { error } = await supabase.from("audit_logs").insert(row);

  if (error) {
    logger.error(
      { err: error, action: input.action, targetId: input.targetId },
      "audit log INSERT failed",
    );
    return false;
  }
  return true;
}