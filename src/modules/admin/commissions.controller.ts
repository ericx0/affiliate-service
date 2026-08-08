import { Request, Response } from "express";
import { z } from "zod";
import { resolveDispute } from "../payouts/payouts.service.js";

// Task 3: POST /api/affiliate/admin/commissions/:id/dispute-resolve
//
// Admin manually resolves a dispute that the Stripe webhook didn't
// auto-resolve (e.g. evidence submitted after auto-close, or fraud
// review override). The auth context (admin identity + TOTP) is
// enforced by adminAuthMiddleware at the route level — this handler
// only parses the body and dispatches.

const Schema = z.object({
  action: z.enum(["won", "lost"]),
  note: z.string().max(500).optional(),
});

export async function postDisputeResolve(req: Request, res: Response) {
  const u = (req as { adminUser?: { id?: string; email?: string } }).adminUser;
  if (!u?.id) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED" } });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: { code: "MISSING_ID" } });
  }

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "INVALID_BODY", message: parsed.error.message },
    });
  }

  const result = await resolveDispute(
    id,
    parsed.data.action,
    parsed.data.note,
    u.id,
    u.email ?? "admin@manual-resolve",
  );

  if (!result.success) {
    const httpStatus =
      result.error === "COMMISSION_NOT_FOUND"
        ? 404
        : result.error === "COMMISSION_NOT_DISPUTED"
        ? 409
        : 500;
    return res.status(httpStatus).json({ error: { code: result.error } });
  }

  res.json({ success: true });
}