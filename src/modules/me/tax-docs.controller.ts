import { Request, Response } from "express";
import { affiliateSupabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

/**
 * GET /api/affiliate/me/tax-docs
 *
 * Returns the KOL's 1099-NEC / year-end summary PDFs as an array, sorted
 * by year descending and capped at the 5 most recent years.
 *
 * NOTE — current state: we do not yet auto-generate 1099-NEC PDFs. The
 * portal was returning an empty array in mock mode. Until the tax-doc
 * generation service is integrated (post-batch-8b), we mirror the same
 * empty shape with status 'pending' per row to keep the dashboard
 * contract stable.
 *
 * Once the generator is wired in, replace the `IN_PRODUCTION` flag with
 * the real query (e.g. SELECT from affiliate.tax_documents JOIN
 * storage.objects).
 */
export async function getMyTaxDocs(_req: Request, res: Response) {
  // The portal shows up to 5 most recent years descending.
  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3, currentYear - 4];

  const docs: Array<{
    year: number;
    form_type: "1099-NEC" | "summary";
    url: string | null;
    status: "available" | "pending";
    generated_at: string | null;
  }> = [];

  // TODO(tax-service-integration): replace with real generated PDF lookup.
  // For each year we don't have a generated PDF for, surface 'pending'.
  // Look in storage bucket `tax-docs` or affiliate.tax_documents once
  // the generator is in place.
  const { data: generated, error: genErr } = await affiliateSupabase
    .from("tax_forms")
    .select("form_type, submitted_at")
    .maybeSingle();
  if (genErr) {
    internalError(res, "TAX_DOCS_QUERY_FAILED", genErr);
    return;
  }
  // tax_forms holds the W-9/W-8BEN (compliance), not 1099-NEC (payout).
  // We surface it for the most recent year only if the KOL has a
  // submitted form — otherwise the row is 'pending'.
  const hasSubmittedForm = Boolean(generated?.submitted_at);
  for (const year of years) {
    docs.push({
      year,
      form_type: "1099-NEC",
      url: null,
      status: "pending",
      generated_at: null,
    });
  }
  // Surface the compliance form for the current year if available —
  // distinct from the 1099-NEC, but the portal lumps them together
  // (different card slot) so we don't double-count.
  void hasSubmittedForm;

  res.json({ data: docs });
}