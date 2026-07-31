import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase, supabase } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";
import { env } from "../../config.js";

/**
 * /api/affiliate/email-templates/*
 *
 * GET   /                          list (filters: category, language, variant)
 * GET   /:id                       single template
 * POST  /:id/render                render with {{variable}} substitutions
 * POST  /:id/send                  render + send via Resend (or save as draft)
 *
 * Templates are seeded in 021_seed_email_templates.sql (4 categories x
 * 5 langs = 20 rows). Send delivery uses the existing Resend
 * integration (notifications.service.ts) when RESEND_API_KEY is set.
 * Otherwise the endpoint returns the rendered text so the KOL can
 * copy/paste into their own email client.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ListQuery = z.object({
  category: z.enum(["dm_invite", "follow_up", "service_pitch", "case_share"]).optional(),
  language: z.enum(["en", "zh", "es", "ar", "ru"]).optional(),
  variant: z.string().max(40).optional(),
});

export async function listTemplates(req: Request, res: Response) {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const q = parsed.data;
  let query = affiliateSupabase
    .from("email_templates")
    .select("id, category, language, title, subject, body, variant, updated_at")
    .eq("is_published", true)
    .order("category", { ascending: true })
    .order("language", { ascending: true })
    .limit(200);
  if (q.category) query = query.eq("category", q.category);
  if (q.language) query = query.eq("language", q.language);
  if (q.variant) query = query.eq("variant", q.variant);

  const { data, error } = await query;
  if (error) return internalError(res, "TEMPLATES_LIST_FAILED", error);
  res.json({ data: (data ?? []).map(shapeTemplate) });
}

export async function getTemplate(req: Request, res: Response) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid template id" } });
  }
  const { data, error } = await affiliateSupabase
    .from("email_templates")
    .select("id, category, language, title, subject, body, variant, updated_at")
    .eq("id", id)
    .eq("is_published", true)
    .maybeSingle();
  if (error) return internalError(res, "TEMPLATE_GET_FAILED", error);
  if (!data) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Template not found" } });
  res.json({ data: shapeTemplate(data) });
}

const RenderSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
});

/**
 * Render-only endpoint. The portal calls this after the KOL fills in
 * prospect_name / kol_name etc; the response is shown in the preview
 * pane. No side effects — safe to call repeatedly.
 */
export async function renderTemplate(req: Request, res: Response) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid template id" } });
  }
  const parsed = RenderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const { data, error } = await affiliateSupabase
    .from("email_templates")
    .select("subject, body")
    .eq("id", id)
    .eq("is_published", true)
    .maybeSingle();
  if (error) return internalError(res, "TEMPLATE_GET_FAILED", error);
  if (!data) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Template not found" } });

  const subject = applyVariables(data.subject, parsed.data.variables);
  const body = applyVariables(data.body, parsed.data.variables);
  res.json({ data: { subject, body, variables: parsed.data.variables } });
}

const SendSchema = z.object({
  to: z.string().email(),
  variables: z.record(z.string(), z.string()).default({}),
});

/**
 * Render + send via Resend. KOLs in any country can hit this; the
 * Resend API is the same regardless of recipient locale. We fall back
 * to a 503 if RESEND_API_KEY is unset — the portal surfaces a banner
 * and shows the rendered body for copy/paste.
 */
export async function sendTemplate(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing promoter context" } });
  }
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid template id" } });
  }
  const parsed = SendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }

  const { data: tmpl, error } = await affiliateSupabase
    .from("email_templates")
    .select("subject, body, category")
    .eq("id", id)
    .eq("is_published", true)
    .maybeSingle();
  if (error) return internalError(res, "TEMPLATE_GET_FAILED", error);
  if (!tmpl) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Template not found" } });

  const subject = applyVariables(tmpl.subject, parsed.data.variables);
  const body = applyVariables(tmpl.body, parsed.data.variables);

  if (!env.RESEND_API_KEY) {
    return res.status(503).json({
      error: {
        code: "MAIL_NOT_READY",
        message: "Email delivery is not configured (RESEND_API_KEY missing); showing rendered preview only.",
        data: { subject, body },
      },
    });
  }

  try {
    const from = env.MAIL_FROM || "LinkChinaMed Partner <partners@linkchinamed.com>";
    const html = bodyToHtml(body);
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: parsed.data.to,
        subject,
        html,
        text: body,
        // Custom headers used by Resend for unsubscribe tracking.
        headers: {
          "X-Entity-Ref-ID": `kol-${promoterId}-tmpl-${id}`,
        },
      }),
    });
    if (!resendRes.ok) {
      const errBody = await resendRes.text().catch(() => "");
      logger.error({ status: resendRes.status, errBody, to: parsed.data.to }, "Resend send failed");
      return res.status(502).json({
        error: { code: "MAIL_PROVIDER_FAILED", message: "Email provider rejected the send" },
      });
    }
    // Record send event (best-effort — failure here doesn't block the
    // email that already left via Resend).
    await supabase.from("affiliate_email_sends").insert({
      promoter_id: promoterId,
      template_id: id,
      to_email: parsed.data.to,
      category: tmpl.category,
    }).then(() => undefined, () => undefined);

    res.status(202).json({ data: { subject, sentAt: new Date().toISOString() } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "sendTemplate threw");
    return internalError(res, "MAIL_PROVIDER_FAILED", err);
  }
}

function applyVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_match, key: string) => {
    const v = vars[key];
    return v === undefined ? `{{${key}}}` : v;
  });
}

function bodyToHtml(body: string): string {
  // Escape the absolute minimum for HTML safety; preserve line breaks.
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const lines = body.split("\n").map((l) => escape(l));
  return lines.join("<br/>\n");
}

function shapeTemplate(row: any) {
  return {
    id: row.id,
    category: row.category,
    language: row.language,
    title: row.title,
    subject: row.subject,
    body: row.body,
    variant: row.variant ?? null,
    updatedAt: row.updated_at,
  };
}
