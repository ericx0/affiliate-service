import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase } from "../../config.js";
import { writeAuditLog } from "../admin/audit.service.js";
import { logger } from "../../utils/logger.js";
import {
  notifyKolCommissionPending,
  notifyKolCommissionReversed,
  notifyKolCommissionPaid,
  notifyKolPayoutSent,
  notifyKolPayoutFailed,
  notifyKolNewReferral,
} from "./notifications.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ParamsSchema = z.object({ id: z.string().regex(UUID_RE) });

const ListQuerySchema = z.object({
  category: z.string().min(1).optional(),
  promoter_id: z.string().regex(UUID_RE).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type NotificationLogStatus = "sent" | "failed" | "pending";

export interface NotificationLogRow {
  id: string;
  promoter_id: string | null;
  template_id: string | null;
  category: string | null;
  to_email: string;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
  status: NotificationLogStatus;
  promoter_email: string | null;
}

/** 状态派生：sent_at 存在 + 无错误 → sent；有错误 → failed；否则 pending。 */
function deriveStatus(sent_at: string | null, last_error: string | null): NotificationLogStatus {
  if (sent_at && !last_error) return "sent";
  if (last_error) return "failed";
  return "pending";
}

interface EmailLogRow {
  id: string;
  promoter_id: string | null;
  to_email: string;
  category: string | null;
  sent_at: string | null;
  last_error: string | null;
}

interface PromoterSnapshot {
  id: string;
  email: string;
  name: string;
}

/**
 * POST /admin/notifications/:id/resend — admin-triggered manual resend of
 * a failed affiliate_email_sends row. The endpoint is read-modify-write:
 *   1. Fetch the log row + the promoter snapshot (name for {{name}}).
 *   2. If the log row is missing → 404 NOT_FOUND.
 *   3. If sent_at is set (previously delivered) → 400 ALREADY_SENT.
 *      Re-sending a delivered email to a real recipient invites support
 *      tickets; the brief explicitly forbids this path.
 *   4. Pick the matching notifyKol* by category (5 known mappings). All
 *      notifyKol* helpers are best-effort + retry + log, so we don't
 *      await for a status code — we just kick them off and return 202.
 *   5. Audit log entry `notification_resend`.
 *
 * The actual send attempt writes its own affiliate_email_sends row, so
 * the log accumulates both the original failure and the manual retry.
 */
export async function resendNotification(req: Request, res: Response): Promise<void> {
  const parsed = ParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid notification id" } });
    return;
  }
  const { id } = parsed.data;
  const ctx = (req as { adminUser?: { id?: string; email?: string } }).adminUser ?? {};
  const actorId = ctx.id ?? "00000000-0000-0000-0000-000000000000";
  const actorEmail = ctx.email ?? "admin@resend-notification";

  const { data: log, error: logErr } = await affiliateSupabase
    .from("affiliate_email_sends" as never)
    .select("id, promoter_id, to_email, category, sent_at, last_error")
    .eq("id", id)
    .maybeSingle();

  if (logErr) {
    logger.error({ err: logErr, id }, "resendNotification: log lookup failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: "Notification log lookup failed" } });
    return;
  }
  const row = log as EmailLogRow | null;
  if (!row) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Notification log not found" } });
    return;
  }
  if (row.sent_at) {
    res.status(400).json({
      error: { code: "ALREADY_SENT", message: "Notification was delivered; cannot resend" },
    });
    return;
  }

  let promoter: PromoterSnapshot | null = null;
  if (row.promoter_id) {
    const { data: p } = await affiliateSupabase
      .from("promoters")
      .select("id, email, name")
      .eq("id", row.promoter_id)
      .maybeSingle();
    promoter = (p as PromoterSnapshot | null) ?? null;
  }

  const fireResend = (): Promise<unknown> => {
    const common = {
      email: row.to_email,
      name: promoter?.name ?? "",
      promoterId: row.promoter_id ?? undefined,
    };
    switch (row.category) {
      case "commission_pending":
        // resend has no fresh commission context; placeholders remain
        // filled from the template defaults (no amount/orderId).
        return notifyKolCommissionPending(common);
      case "commission_reversed":
        return notifyKolCommissionReversed({ ...common, reason: "manual resend" });
      case "commission_paid":
        return notifyKolCommissionPaid(common);
      case "payout_sent":
        return notifyKolPayoutSent(common);
      case "payout_failed":
        return notifyKolPayoutFailed({ ...common, reason: "manual resend" });
      case "new_referral":
        return notifyKolNewReferral(common);
      default:
        logger.warn({ id, category: row.category }, "resend: unknown category");
        return Promise.resolve();
    }
  };

  // Fire-and-forget — best-effort path mirrors the rest of the service.
  void fireResend().catch((e) => logger.error({ err: (e as Error).message, id }, "resend threw"));

  await writeAuditLog({
    actorId,
    actorEmail,
    action: "notification_resend",
    targetType: "email_send",
    targetId: id,
    beforeState: { category: row.category, to_email: row.to_email, last_error: row.last_error },
    reason: "admin manual resend",
  });

  res.status(202).json({ data: { id, requeued: true } });
}

/**
 * GET /admin/notifications — admin-only notification log listing with
 * optional filters (category, promoter_id, limit ≤ 200). Status is
 * derived from sent_at + last_error rather than stored, keeping the
 * schema lean (Task 3.2 didn't add a status column by design).
 * Joins promoters for the email column so the UI can show KOL邮箱
 * without a second round-trip.
 */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid query", details: parsed.error.flatten() },
    });
    return;
  }
  const { category, promoter_id, limit } = parsed.data;

  let q = affiliateSupabase
    .from("affiliate_email_sends" as never)
    .select("id, promoter_id, template_id, category, to_email, sent_at, last_error, created_at, promoters!affiliate_email_sends_promoter_id_fkey(email)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (category) q = q.eq("category", category);
  if (promoter_id) q = q.eq("promoter_id", promoter_id);

  const { data, error } = await q;
  if (error) {
    logger.error({ err: error }, "listNotifications query failed");
    res.status(500).json({ error: { code: "QUERY_FAILED", message: "Notification log query failed" } });
    return;
  }

  const rows = (data ?? []) as Array<Omit<NotificationLogRow, "status" | "promoter_email"> & {
    promoters?: { email?: string | null } | { email?: string | null }[] | null;
  }>;

  const result: NotificationLogRow[] = rows.map((r) => {
    const promoterJoin = Array.isArray(r.promoters) ? r.promoters[0] : r.promoters;
    const promoterEmail =
      promoterJoin && typeof promoterJoin === "object" && "email" in promoterJoin
        ? (promoterJoin.email ?? null)
        : null;
    const { promoters: _p, ...rest } = r;
    return {
      ...rest,
      status: deriveStatus(rest.sent_at, rest.last_error),
      promoter_email: promoterEmail,
    };
  });

  res.json({ data: result });
}