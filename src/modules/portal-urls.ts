import { env } from "../config.js";

const KOL_PORTAL_BASE = env.PORTAL_URL || "https://affiliate.linkchinamed.com";
const AGENT_PORTAL_BASE = env.AGENT_PORTAL_URL || "https://agent.linkchinamed.com";

/**
 * Stripe Connect onboarding return URL. Different per role:
 *   - kol:   <KOL_PORTAL>/dashboard/settings/stripe
 *   - agent: <AGENT_PORTAL>/dashboard/settings/stripe
 *
 * Used by stripe-connect.controller.ts (refresh_url / return_url),
 * admin/kyc.controller.ts (admin-created accounts), and the dev-mock
 * flow when NODE_ENV=development.
 */
export function settingsStripeReturnUrl(role: "kol" | "agent"): string {
  const base = role === "agent" ? AGENT_PORTAL_BASE : KOL_PORTAL_BASE;
  return `${base}/dashboard/settings/stripe`;
}

/**
 * Promoter dashboard URL by role. Used by notifications.service.ts
 * to build commission-paid email links.
 */
export function dashboardUrlFor(role: "kol" | "agent"): string {
  const base = role === "agent" ? AGENT_PORTAL_BASE : KOL_PORTAL_BASE;
  return `${base}/dashboard`;
}