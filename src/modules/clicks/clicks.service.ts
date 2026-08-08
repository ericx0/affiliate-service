import { z } from "zod";
import { affiliateSupabase, env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { isValidCodeFormat } from "../../utils/code-generator.js";

export const ATTRIBUTION_WINDOW_DAYS = env.ATTRIBUTION_WINDOW_DAYS;

const TrackClickSchema = z.object({
  referralCode: z.string().min(4).max(32),
  source: z.enum(["link", "coupon", "qr"]).default("link"),
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
  source?: "link" | "coupon" | "qr";
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

export interface AttributionConfig {
  mode: "first_click" | "last_click";
  windowDays: number;
}

const ATTRIBUTION_CONFIG_CACHE_MS = 60 * 60 * 1000;
const DEDUP_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  mode: "last_click",
  windowDays: 30,
};

let cachedAttributionConfig: AttributionConfig | null = null;
let attributionConfigExpiresAt = 0;

export async function getAttributionConfig(): Promise<AttributionConfig> {
  if (cachedAttributionConfig && Date.now() < attributionConfigExpiresAt) {
    return cachedAttributionConfig;
  }

  const { data, error } = await affiliateSupabase
    .from("attribution_config")
    .select("mode, window_days")
    .eq("scope", "global")
    .single();

  if (
    !error &&
    data &&
    (data.mode === "first_click" || data.mode === "last_click") &&
    Number.isInteger(data.window_days) &&
    data.window_days > 0
  ) {
    cachedAttributionConfig = { mode: data.mode, windowDays: data.window_days };
  } else {
    cachedAttributionConfig = DEFAULT_ATTRIBUTION_CONFIG;
  }
  attributionConfigExpiresAt = Date.now() + ATTRIBUTION_CONFIG_CACHE_MS;
  return cachedAttributionConfig;
}

/**
 * Check if a click is still within the 30-day attribution window.
 */
export function isWithinAttributionWindow(clickedAt: string): boolean {
  const elapsedMs = Date.now() - new Date(clickedAt).getTime();
  const windowMs = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return elapsedMs <= windowMs;
}

interface RecentClick {
  id: string;
  first_click_at: string;
  last_click_at: string;
  clicked_at: string;
  converted_order_id: string | null;
}

async function findRecentClick(
  input: z.infer<typeof TrackClickSchema>,
): Promise<RecentClick | null> {
  if (!input.visitorSessionId && !input.ipAddress) return null;

  let query = affiliateSupabase
    .from("referral_clicks")
    .select("id, first_click_at, last_click_at, clicked_at, converted_order_id")
    .eq("referral_code", input.referralCode);
  query = input.visitorSessionId
    ? query.eq("visitor_session_id", input.visitorSessionId)
    : query.eq("ip_address", input.ipAddress!);

  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const { data } = await query.gte("clicked_at", cutoff).limit(1);
  const recent = data?.[0] ?? null;
  return recent?.converted_order_id ? null : recent;
}

async function updateRecentClick(options: {
  clickId: string;
  mode: AttributionConfig["mode"];
  source: "link" | "coupon" | "qr";
  now: string;
  windowEnd: string;
}): Promise<{ message: string } | null> {
  const timestamps = options.mode === "last_click"
    ? { first_click_at: options.now, last_click_at: options.now }
    : { last_click_at: options.now };
  const { error } = await affiliateSupabase
    .from("referral_clicks")
    .update({
      ...timestamps,
      source: options.source,
      attribution_window_ends_at: options.windowEnd,
    })
    .eq("id", options.clickId);
  return error;
}

/**
 * Record a referral click using the configured first/last-click mode.
 */
export async function trackClick(input: TrackClickInput): Promise<TrackClickResult> {
  const validated = TrackClickSchema.parse(input);
  if (!isValidCodeFormat(validated.referralCode)) {
    return { recorded: false, reason: "Invalid code format" };
  }

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

  const config = await getAttributionConfig();
  const now = new Date().toISOString();
  const windowEnd = new Date(Date.now() + config.windowDays * 24 * 60 * 60 * 1000).toISOString();
  const existing = await findRecentClick(validated);
  if (existing) {
    const error = await updateRecentClick({
      clickId: existing.id,
      mode: config.mode,
      source: validated.source,
      now,
      windowEnd,
    });
    if (error) return { recorded: false, reason: error.message };
    return { recorded: true, clickId: existing.id, promoterId: codeRow.promoter_id };
  }

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
      source: validated.source,
      first_click_at: now,
      last_click_at: now,
      clicked_at: now,
      attribution_window_ends_at: windowEnd,
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