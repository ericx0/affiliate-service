import crypto from "node:crypto";
import { isValidCodeFormat } from "../../utils/code-generator.js";

/**
 * Generate a UUID v4 visitor session ID. Used in main-site middleware
 * to track anonymous visitors across the 30-day attribution window.
 */
export function generateVisitorSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Extract referral code from URL query or cookie. Validates format.
 * Query param takes precedence (for landing pages with ?ref=).
 */
export function extractReferralCode(url: URL, cookieValue: string | null): string | null {
  const queryRef = url.searchParams.get("ref");
  const candidate = queryRef || cookieValue;

  if (!candidate) return null;
  if (!isValidCodeFormat(candidate)) return null;
  return candidate;
}

/**
 * Payload sent to affiliate-service to record a click.
 */
export interface TrackClickPayload {
  referralCode: string;
  visitorSessionId: string;
  ipAddress?: string;
  userAgent?: string;
  country?: string;
}