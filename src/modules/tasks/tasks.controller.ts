import { Request, Response } from "express";
import { affiliateSupabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * POST /api/affiliate/tasks/:id/complete
 *
 * Marks a followup_task as completed by the authenticated KOL. The
 * promoter_id filter enforces "KOL can only complete their own tasks".
 * Idempotent: a re-call returns 200 with the existing completed_at
 * timestamp rather than overwriting it.
 */
export async function completeMyTask(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
    return;
  }
  const { id } = req.params;
  if (!isUuid(id)) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid task id" } });
    return;
  }

  // Fetch the row first so we can return the canonical 404 for both
  // missing and not-owned cases.
  const { data: task, error: fetchErr } = await affiliateSupabase
    .from("followup_tasks")
    .select("id, completed_at, dismissed_at, day, task_type, due_at, client_id, promoter_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    internalError(res, "TASK_LOOKUP_FAILED", fetchErr);
    return;
  }
  if (!task || task.promoter_id !== promoterId) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Task not found" } });
    return;
  }
  if (task.dismissed_at) {
    // Dismissed tasks are treated as terminal — the KOL opted out,
    // we shouldn't silently re-complete them.
    res.status(409).json({ error: { code: "TASK_DISMISSED", message: "Task was dismissed" } });
    return;
  }
  if (task.completed_at) {
    res.json({ data: { ...task, completed_at: task.completed_at } });
    return;
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await affiliateSupabase
    .from("followup_tasks")
    .update({ completed_at: now })
    .eq("id", id)
    .eq("promoter_id", promoterId)
    .select("id, completed_at, day, task_type, due_at, client_id, promoter_id")
    .single();
  if (updateErr) {
    internalError(res, "TASK_COMPLETE_FAILED", updateErr);
    return;
  }
  res.json({ data: updated });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}