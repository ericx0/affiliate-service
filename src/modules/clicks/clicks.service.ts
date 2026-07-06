import { z } from "zod";
import { supabase } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { isValidCodeFormat } from "../../utils/code-generator.js";

export const ATTRIBUTION_WINDOW_DAYS = 30;

const TrackClickSchema = z.object({
  referralCode: z.string().min(4).max(32),
  visitorSessionId: z.string().uuid(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  country: z.string().length(2).optional(),
});

export interface TrackClickInput {
  referralCode: string;
  visitorSessionId: string;
  ipAddress?: string;
  userAgent?: string;
  country?: string;
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
 * Returns existing click if same session+code already recorded (idempotency).
 */
export async function trackClick(input: TrackClickInput): Promise<TrackClickResult> {
  const validated = TrackClickSchema.parse(input);

  if (!isValidCodeFormat(validated.referralCode)) {
    return { recorded: false, reason: "Invalid code format" };
  }

  // Look up promoter via code
  const { data: codeRow, error: codeErr } = await supabase
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

  // Idempotency: check if this session+code already recorded recently
  const { data: existing } = await supabase
    .from("referral_clicks")
    .select("id")
    .eq("visitor_session_id", validated.visitorSessionId)
    .eq("referral_code", validated.referralCode)
    .gte("clicked_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())  // last 1h
    .limit(1);

  if (existing && existing.length > 0) {
    return { recorded: true, clickId: existing[0].id, promoterId: codeRow.promoter_id, reason: "Duplicate (last 1h)" };
  }

  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + ATTRIBUTION_WINDOW_DAYS);

  const { data: click, error: insertErr } = await supabase
    .from("referral_clicks")
    .insert({
      referral_code: validated.referralCode,
      promoter_id: codeRow.promoter_id,
      visitor_session_id: validated.visitorSessionId,
      ip_address: validated.ipAddress || null,
      user_agent: validated.userAgent || null,
      country: validated.country || null,
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
  const { data, error } = await supabase
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
  await supabase
    .from("referral_clicks")
    .update({
      [updateField]: conversionId,
      converted_at: new Date().toISOString(),
    })
    .eq("visitor_session_id", visitorSessionId)
    .is(updateField, null);  // only set if not already set
}