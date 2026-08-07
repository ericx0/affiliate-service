import { Request, Response } from "express";
import { z } from "zod";
import { stripe, affiliateSupabase, supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { writeAuditLog } from "./audit.service.js";
import { internalError } from "../../utils/controller-error.js";
import { settingsStripeReturnUrl } from "../portal-urls.js";

const adminCtx = (req: Request) => {
  const u = (req as any).adminUser;
  return {
    adminId: u?.id || "00000000-0000-0000-0000-000000000000",
    adminEmail: u?.email || "unknown@linkchinamed.com",
  };
};

// ============================================================
// GET /admin/promoters/:id/tax-form-url
//
// Generate a 60-second signed URL for the KOL's signed tax form
// PDF (stored in the private `tax-forms` bucket). The admin UI
// opens this in a new tab; the URL expires automatically. Every
// access is audit-logged (kyc.tax_form_url_viewed).
//
// service_role bypasses both RLS on affiliate.tax_forms AND the
// per-folder storage policy, so no new storage policy is needed.
// ============================================================
export async function getTaxFormSignedUrl(req: Request, res: Response) {
  const promoterId = req.params.id;
  const ctx = adminCtx(req);

  const { data: taxForm, error: tfErr } = await affiliateSupabase
    .from("tax_forms")
    .select("file_path, form_type, status")
    .eq("promoter_id", promoterId)
    .maybeSingle();

  if (tfErr) return internalError(res, "TAX_FORM_QUERY_FAILED", tfErr);
  if (!taxForm) {
    return res.status(404).json({
      error: { code: "NO_TAX_FORM", message: "Promoter has not submitted a tax form" },
    });
  }

  const { data: signed, error: stErr } = await supabase.storage
    .from("tax-forms")
    .createSignedUrl(taxForm.file_path, 60);

  if (stErr || !signed) {
    return internalError(res, "SIGNED_URL_FAILED", stErr);
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "kyc.tax_form_url_viewed",
    targetType: "promoter",
    targetId: promoterId,
    afterState: { file_path: taxForm.file_path, form_type: taxForm.form_type },
    reason: "admin viewed signed tax form URL",
  });

  res.json({
    data: {
      url: signed.signedUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
}

// ============================================================
// POST /admin/promoters/:id/stripe-reset
//
// Body: { reason: string }
//
// Re-issue a one-time Stripe account onboarding link for an
// existing connected account (does NOT create a new account —
// promoter.stripe_account_id is the source of truth). Used when:
//   - KOL's onboarding link expired before they finished
//   - Stripe disabled the account and admin needs KOL to re-submit
//   - Bank/identity doc needs re-verification after a Stripe update
//
// 409 if no stripe_account_id yet (KOL hasn't started onboarding).
// ============================================================
const StripeResetSchema = z.object({
  reason: z.string().min(1).max(500),
});

export async function postStripeReset(req: Request, res: Response) {
  const promoterId = req.params.id;
  const ctx = adminCtx(req);

  const parsed = StripeResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() },
    });
  }
  const { reason } = parsed.data;

  const { data: promoter, error: pErr } = await affiliateSupabase
    .from("promoters")
    .select("id, email, stripe_account_id, stripe_onboarding_completed, role")
    .eq("id", promoterId)
    .maybeSingle();

  if (pErr) return internalError(res, "PROMOTER_QUERY_FAILED", pErr);
  if (!promoter) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Promoter not found" },
    });
  }
  if (!promoter.stripe_account_id) {
    return res.status(409).json({
      error: {
        code: "STRIPE_NOT_STARTED",
        message: "KOL has not started Stripe onboarding yet. Ask them to connect from their dashboard.",
      },
    });
  }

  const role = (promoter.role === "agent" ? "agent" : "kol");

  let link;
  try {
    link = await stripe.accountLinks.create({
      account: promoter.stripe_account_id,
      refresh_url: `${settingsStripeReturnUrl(role)}?refresh=true`,
      return_url: `${settingsStripeReturnUrl(role)}?return=true`,
      type: "account_onboarding",
    });
  } catch (stripeErr) {
    logger.error(
      { err: stripeErr, accountId: promoter.stripe_account_id },
      "stripe.accountLinks.create failed (admin reset)",
    );
    return res.status(502).json({
      error: { code: "STRIPE_FAILED", message: "Stripe did not issue a new onboarding link" },
    });
  }

  await writeAuditLog({
    actorId: ctx.adminId,
    actorEmail: ctx.adminEmail,
    action: "kyc.stripe_reset_link_issued",
    targetType: "promoter",
    targetId: promoterId,
    beforeState: { stripe_onboarding_completed: promoter.stripe_onboarding_completed },
    afterState: { link_expires_at: link.expires_at },
    reason,
  });

  res.json({
    data: {
      url: link.url,
      accountId: promoter.stripe_account_id,
      expiresAt: new Date(link.expires_at * 1000).toISOString(),
    },
  });
}