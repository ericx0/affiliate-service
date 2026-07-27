import { z } from "zod";
import { affiliateSupabase, env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { isValidCodeFormat } from "../../utils/code-generator.js";

export const ATTRIBUTION_WINDOW_DAYS = env.ATTRIBUTION_WINDOW_DAYS;

const TrackClickSchema = z.object({
  referralCode: z.string().min(4).max(32),
  // Optional: the edge middleware calls /clicks/track before any visitor
  // cookie exists, so server-side callers may not have a session id.
  // visitor_session_id is nullable in affiliate.referral_clicks.
  visitorSessionId: z.string().uuid().optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  country: z.string().length(2).optional(),
  landingPath: z.string().max(500).optional(),
  referrer: z.string().max(1000).optional(),
  utmSource: z.string().max(100).optional(),
  utmMedium: z.string().max(100).optional(),
  utmCampaign: z.string().max(100).optional(),
  utmTerm: z.string().max(100).optional(),
  utmContent: z.string().max(100).optional(),
});

export interface TrackClickInput {
  referralCode: string;
  visitorSessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  landingPath?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
}

export interface TrackClickResult {
  recorded: boolean;
  clickId?: string;
  promoterId?: string;
  reason?: string;
}

/**
 * Check if a click is still within the 30-day attribution window.
 */
export function isWithinAttributionWindow(clickedAt: string): boolean {
  const elapsedMs = Date.now() - new Date(clickedAt).getTime();
  const windowMs = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return elapsedMs <= windowMs;
}

/**
 * Record a referral click. Validates the code and creates a click record.
 * Returns existing click if a duplicate was recorded recently (idempotency):
 * keyed on session+code when a visitor session id is present, otherwise on
 * ip+code (server-side callers without a session) — both within the last 1h.
 */
export async function trackClick(input: TrackClickInput): Promise<TrackClickResult> {
  const validated = TrackClickSchema.parse(input);

  if (!isValidCodeFormat(validated.referralCode)) {
    return { recorded: false, reason: "Invalid code format" };
  }

  // Look up promoter via code
  const { data: codeRow, error: codeErr } = await affiliateSupabase
    .from("referral_codes")
    .select("promoter_id, is_active, expires_at")
    .eq("code", validated.referralCode)
    .eq("is_active", true)
    .single();

  if (codeErr || !codeRow) {
    logger.info({ code: validated.referralCode }, "referral code not found or inactive");
    return { recorded: false, reason: "Code not found" };
  }

  if (codeRow.expires_at && new Date(codeRow.expires_at) < new Date()) {
    return { recorded: false, reason: "Code expired" };
  }

  // Idempotency: skip if this visitor already clicked this code recently.
  // Session-keyed when available; IP-keyed otherwise (edge middleware calls
  // before any visitor cookie exists).
  const recentCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();  // last 1h
  let existing: Array<{ id: string }> | null = null;
  if (validated.visitorSessionId || validated.ipAddress) {
    let dupQuery = affiliateSupabase
      .from("referral_clicks")
      .select("id")
      .eq("referral_code", validated.referralCode);
    if (validated.visitorSessionId) {
      dupQuery = dupQuery.eq("visitor_session_id", validated.visitorSessionId);
    } else {
      dupQuery = dupQuery.eq("ip_address", validated.ipAddress!);
    }
    const { data } = await dupQuery
      .gte("clicked_at", recentCutoff)
      .limit(1);
    existing = data;
  }

  if (existing && existing.length > 0) {
    return { recorded: true, clickId: existing[0].id, promoterId: codeRow.promoter_id, reason: "Duplicate (last 1h)" };
  }

  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + ATTRIBUTION_WINDOW_DAYS);

  const { data: click, error: insertErr } = await affiliateSupabase
    .from("referral_clicks")
    .insert({
      referral_code: validated.referralCode,
      promoter_id: codeRow.promoter_id,
      visitor_session_id: validated.visitorSessionId || null,
      ip_address: validated.ipAddress || null,
      user_agent: validated.userAgent || null,
      country: validated.country || null,
      landing_path: validated.landingPath || null,
      referrer: validated.referrer || null,
      utm_source: validated.utmSource || null,
      utm_medium: validated.utmMedium || null,
      utm_campaign: validated.utmCampaign || null,
      utm_term: validated.utmTerm || null,
      utm_content: validated.utmContent || null,
      clicked_at: now.toISOString(),
      attribution_window_ends_at: windowEnd.toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    logger.error({ error: insertErr }, "failed to record click");
    return { recorded: false, reason: insertErr.message };
  }

  logger.info({ clickId: click.id, code: validated.referralCode }, "click recorded");
  return { recorded: true, clickId: click.id, promoterId: codeRow.promoter_id };
}

/**
 * Find an active click for a session within the attribution window.
 * Used by order attach to determine promoter.
 */
export async function findActiveClickForSession(visitorSessionId: string): Promise<{
  promoterId: string;
  referralCode: string;
} | null> {
  const { data, error } = await affiliateSupabase
    .from("referral_clicks")
    .select("promoter_id, referral_code, attribution_window_ends_at")
    .eq("visitor_session_id", visitorSessionId)
    .is("converted_order_id", null)
    .gt("attribution_window_ends_at", new Date().toISOString())
    .order("clicked_at", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;

  return {
    promoterId: data[0].promoter_id,
    referralCode: data[0].referral_code,
  };
}

/**
 * Mark a click as converted (when order is created or signup happens).
 */
export async function markClickConverted(
  visitorSessionId: string,
  conversionType: "user" | "order",
  conversionId: string
): Promise<void> {
  const updateField = conversionType === "user" ? "converted_user_id" : "converted_order_id";
  await affiliateSupabase
    .from("referral_clicks")
    .update({
      [updateField]: conversionId,
      converted_at: new Date().toISOString(),
    })
    .eq("visitor_session_id", visitorSessionId)
    .is(updateField, null);  // only set if not already set
}