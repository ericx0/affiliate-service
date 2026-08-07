import { env } from "../config.js";

const PORTAL_BASE = env.PORTAL_URL || "https://affiliate.linkchinamed.com";

/**
 * Stripe Connect onboarding return URL. Different per role:
 *   - kol:   /kol/dashboard/settings/stripe
 *   - agent: /agent/dashboard/settings/stripe
 *
 * Used by stripe-connect.controller.ts (refresh_url / return_url),
 * admin/kyc.controller.ts (admin-created accounts), and the dev-mock
 * flow when NODE_ENV=development.
 */
export function settingsStripeReturnUrl(role: "kol" | "agent"): string {
  return `${PORTAL_BASE}/${role === "agent" ? "agent" : "kol"}/dashboard/settings/stripe`;
}

/**
 * Promoter dashboard URL by role. Used by notifications.service.ts
 * to build commission-paid email links.
 */
export function dashboardUrlFor(role: "kol" | "agent"): string {
  return `${PORTAL_BASE}/${role === "agent" ? "agent" : "kol"}/dashboard`;
}