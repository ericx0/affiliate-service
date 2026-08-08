import { Request, Response } from "express";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { adminCtx } from "./admin.controller.js";
import { resolveDispute } from "../payouts/payouts.service.js";

// Task 3: POST /api/affiliate/admin/commissions/:id/dispute-resolve
const Schema = z.object({
  action: z.enum(["won", "lost"]),
  note: z.string().max(500).optional(),
});

export async function postDisputeResolve(req: Request, res: Response) {
  const ctx = adminCtx(req);
  if (!ctx.adminId || ctx.adminId === "00000000-0000-0000-0000-000000000000") {
    return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
  }

  const { id } = req.params;
  if (!id) return res.status(400).json({ error: { code: "MISSING_ID" } });

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "INVALID_BODY", message: parsed.error.message } });
  }

  try {
    const result = await resolveDispute(
      id,
      parsed.data.action,
      parsed.data.note,
      ctx.adminId,
      ctx.adminEmail,
    );
    if (!result.success) {
      const httpStatus =
        result.error === "COMMISSION_NOT_FOUND" ? 404
          : result.error === "COMMISSION_NOT_DISPUTED" ? 409
            : result.error === "DB_ERROR" ? 500 : 500;
      return res.status(httpStatus).json({ error: { code: result.error } });
    }
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error, commissionId: id }, "manual dispute resolution failed");
    return res.status(500).json({ error: { code: "INTERNAL" } });
  }
}
