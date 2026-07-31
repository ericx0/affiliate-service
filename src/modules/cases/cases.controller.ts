import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase, getOpenAIClient, env } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";

/**
 * /api/affiliate/cases/* — Real-case library browsing + AI rewrite.
 *
 * GET   /api/affiliate/cases              — list (filters: category, country)
 * GET   /api/affiliate/cases/:id          — single case
 * POST  /api/affiliate/cases/:id/rewrite  — AI rewrite for a given platform/audience
 *
 * The case-library table is affiliate.cases (migration 013). RLS already
 * lets KOLs read published rows; we add owner-read policy on top of
 * service_role reads for the AI rewrite endpoint.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ListQuery = z.object({
  category: z.string().max(40).optional(),
  country: z.string().max(8).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function listCases(req: Request, res: Response) {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const q = parsed.data;
  let query = affiliateSupabase
    .from("cases")
    .select("id, treatment_category, hospital, country, age_range, gender, origin_country, summary_en, summary_zh, outcome_en, outcome_zh, cost_range_low_cents, cost_range_high_cents, updated_at")
    .eq("is_published", true)
    .order("updated_at", { ascending: false })
    .limit(q.limit);
  if (q.category) query = query.eq("treatment_category", q.category);
  if (q.country) query = query.eq("country", q.country);

  const { data, error } = await query;
  if (error) return internalError(res, "CASES_LIST_FAILED", error);
  res.json({ data: (data ?? []).map(shapeCase) });
}

export async function getCase(req: Request, res: Response) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid case id" } });
  }
  const { data, error } = await affiliateSupabase
    .from("cases")
    .select("*")
    .eq("id", id)
    .eq("is_published", true)
    .maybeSingle();
  if (error) return internalError(res, "CASE_GET_FAILED", error);
  if (!data) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Case not found" } });
  }
  res.json({ data: shapeCase(data) });
}

const RewriteSchema = z.object({
  platform: z.enum(["ig", "tiktok", "fb", "youtube", "linkedin", "x", "email", "dm"]),
  audience: z.enum(["general", "patient_us", "patient_eu", "patient_ru", "patient_kr", "patient_br", "agent_b2b"]).default("general"),
  language: z.enum(["en", "zh", "es", "ar", "ru"]).default("en"),
  tone: z.enum(["warm", "factual", "urgent"]).default("warm"),
}).strict();

/**
 * POST /api/affiliate/cases/:id/rewrite
 *
 * Generates a multi-format rewrite of the case for the chosen
 * platform/audience. We use OpenAI (gpt-4o-mini by default). If the
 * key is missing the endpoint returns 503 NOT_READY — the portal
 * shows a friendly banner instead of a stack trace.
 *
 * Output shape: { variants: [{ platform, body, hashtags?, subject? }] }
 * Three variants per call (short / medium / long-form) so the KOL can
 * pick the right format for the channel.
 */
export async function rewriteCase(req: Request, res: Response) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid case id" } });
  }
  const parsed = RewriteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const opts = parsed.data;

  const { data: c, error } = await affiliateSupabase
    .from("cases")
    .select("treatment_category, hospital, country, age_range, gender, origin_country, summary_en, summary_zh, outcome_en, outcome_zh, anonymized_data, cost_range_low_cents, cost_range_high_cents")
    .eq("id", id)
    .eq("is_published", true)
    .maybeSingle();
  if (error) return internalError(res, "CASE_GET_FAILED", error);
  if (!c) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Case not found" } });

  const client = getOpenAIClient();
  if (!client) {
    return res.status(503).json({
      error: {
        code: "AI_NOT_READY",
        message: "AI rewrite is not configured (OPENAI_API_KEY missing)",
      },
    });
  }

  try {
    const variants = await generateRewrite(client, c as CaseRow, opts);
    res.json({ data: variants });
  } catch (err) {
    logger.warn({ err: (err as Error).message, id }, "case rewrite failed");
    return internalError(res, "AI_REWRITE_FAILED", err);
  }
}

interface CaseRow {
  treatment_category: string;
  hospital: string;
  country: string;
  age_range: string;
  gender: string;
  origin_country: string | null;
  summary_en: string;
  summary_zh: string | null;
  outcome_en: string;
  outcome_zh: string | null;
  anonymized_data: Record<string, unknown> | null;
  cost_range_low_cents: number | null;
  cost_range_high_cents: number | null;
}

async function generateRewrite(
  // Use `any` for the client so we don't pin the import shape — the
  // openai package's types evolve across versions and the controller
  // only ever calls one method.
  client: any,
  c: CaseRow,
  opts: { platform: string; audience: string; language: string; tone: string },
): Promise<Array<{ length: string; body: string; hashtags?: string[] }>> {
  const costLine =
    c.cost_range_low_cents && c.cost_range_high_cents
      ? `Approximate cost: $${Math.round(c.cost_range_low_cents / 100).toLocaleString()}–$${Math.round(
          c.cost_range_high_cents / 100,
        ).toLocaleString()} USD.`
      : "";

  const systemPrompt = [
    "You are a KOL marketing copywriter for LinkChinaMed (跨境医疗服务).",
    "Your job is to rewrite anonymised real cases into platform-native content.",
    "Hard rules (always enforced):",
    "  1. NEVER invent medical outcomes — only paraphrase the case summary + outcome.",
    "  2. NEVER use the patient's name / age / city. Anonymised buckets only.",
    "  3. NEVER promise specific outcomes. Use 'similar cases' framing.",
    "  4. ALWAYS end with a soft CTA: 'For personal guidance, request a free pre-review via the LCM team.'",
    "  5. NEVER include medical claims about cures / success rates.",
    "Output JSON: { 'variants': [{ 'length': 'short'|'medium'|'long', 'body': string, 'hashtags': string[] }] }.",
  ].join("\n");

  const userPrompt = [
    `Case:`,
    `- Treatment: ${c.treatment_category}`,
    `- Hospital: ${c.hospital}`,
    `- Country: ${c.country}`,
    `- Patient bucket: ${c.age_range} ${c.gender} from ${c.origin_country ?? "unknown"}`,
    `- Summary: ${c.summary_en}`,
    `- Outcome: ${c.outcome_en}`,
    costLine ? `- ${costLine}` : "",
    ``,
    `Platform: ${opts.platform}`,
    `Audience: ${opts.audience}`,
    `Language: ${opts.language}`,
    `Tone: ${opts.tone}`,
    ``,
    `Generate 3 variants: short (<= 280 chars, social caption), medium (300-800 chars, IG/TikTok caption), long (blog/LinkedIn-length 800-1500 chars).`,
  ]
    .filter(Boolean)
    .join("\n");

  const resp = await client.chat.completions.create({
    model: env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 1400,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = resp.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");
  const parsed = JSON.parse(content) as { variants?: Array<{ length?: string; body?: string; hashtags?: string[] }> };
  const list = Array.isArray(parsed.variants) ? parsed.variants : [];
  return list.slice(0, 3).map((v) => ({
    length: (v.length as "short" | "medium" | "long") ?? "medium",
    body: String(v.body ?? "").trim(),
    hashtags: Array.isArray(v.hashtags) ? v.hashtags.slice(0, 12) : [],
  }));
}

function shapeCase(row: any) {
  return {
    id: row.id,
    treatmentCategory: row.treatment_category,
    hospital: row.hospital,
    country: row.country,
    ageRange: row.age_range,
    gender: row.gender,
    originCountry: row.origin_country ?? null,
    summaryEn: row.summary_en,
    summaryZh: row.summary_zh ?? null,
    outcomeEn: row.outcome_en,
    outcomeZh: row.outcome_zh ?? null,
    anonymizedData: row.anonymized_data ?? {},
    costRangeLowCents: row.cost_range_low_cents ?? null,
    costRangeHighCents: row.cost_range_high_cents ?? null,
    updatedAt: row.updated_at,
  };
}
