import { Request, Response } from "express";
import { z } from "zod";
import { supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";

const QuerySchema = z.object({
  email: z.string().email().max(254),
});

/**
 * GET /admin/signings?email=...
 *
 * Audit-only endpoint. Returns all documents.signings rows for a given
 * signer_email, joined with documents.templates.type so the auditor can
 * see which legal documents the signer consented to (and on which version
 * via signed_content_hash). Used by the affiliate-portal E2E spec to
 * assert both NDA + Affiliate Agreement are recorded for a fresh register.
 */
export async function getSigningsByEmail(req: Request, res: Response) {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
    return;
  }
  const { email } = parsed.data;

  const { data, error } = await supabase
    .schema("documents")
    .from("signings")
    .select("id, template_id, signer_email, signer_name, status, signed_at, signed_content_hash, templates:documents.templates!inner(type, version)")
    .eq("signer_email", email.toLowerCase())
    .order("signed_at", { ascending: false });

  if (error) {
    internalError(res, "SIGNINGS_QUERY_FAILED", error);
    return;
  }

  const rawRows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const rows = rawRows.map((row) => {
    const t = row.templates as { type: string; version: string } | { type: string; version: string }[] | null;
    const template = Array.isArray(t) ? t[0] : t;
    return {
      id: row.id,
      templateId: row.template_id,
      templateType: template?.type ?? null,
      templateVersion: template?.version ?? null,
      signerEmail: row.signer_email,
      signerName: row.signer_name,
      status: row.status,
      signedAt: row.signed_at,
      signedContentHash: row.signed_content_hash,
    };
  });

  res.status(200).json({ data: rows });
}