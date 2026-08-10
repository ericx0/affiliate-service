import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  APP_URL: z.string().url(),
  WEB_URL: z.string().url(),
  // KOL portal URL (e.g. https://affiliate.linkchinamed.com). Used
  // as the base for Stripe Connect return/refresh URLs. Falls back
  // to WEB_URL when not set (dev convenience).
  PORTAL_URL: z.string().url().optional(),

  // Agent portal URL (e.g. https://agent.linkchinamed.com). Used as the base
  // for Stripe Connect return/refresh URLs and dashboard links for agents.
  AGENT_PORTAL_URL: z.string().url().optional(),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  LCM_AFFILIATE_SECRET: z.string().min(32, "HMAC secret must be at least 32 chars"),

  // Email notifications via Resend (optional - notifications silently skip
  // if RESEND_API_KEY is unset, so the service still starts without them).
  RESEND_API_KEY: z.string().optional(),
  ADMIN_NOTIFY_EMAIL: z.string().email().optional(),
  MAIL_FROM: z.string().optional(),

  // OpenAI — used to suggest next steps after KOL<->client contact logs.
  // Optional: the contact-log endpoint gracefully degrades (returns null
  // suggestions) when OPENAI_API_KEY is absent.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  // Attribution window (days) for referral clicks. Default 30.
  ATTRIBUTION_WINDOW_DAYS: z.coerce.number().int().positive().default(30),

  // ---- Multi-platform social publishing (batch 8e-P0 / T1) ----
  // Comma-separated allowlist of platforms whose app review has been
  // approved. Empty = no platforms enabled (operator flips per
  // platform as approvals land). Example: "ig,fb,x".
  SOCIAL_PLATFORM_READY: z.string().optional(),

  // Meta (Instagram + Facebook Business Login).
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  // Google (YouTube Data API v3).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // LinkedIn UGC.
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),

  // X (Twitter) OAuth 2.0.
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),

  // TikTok for Developers.
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const env = EnvSchema.parse(process.env);
if (env.NODE_ENV !== "test") {
  console.log(`[config] env validated: NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT}`);
}

import { createClient, SupabaseClient } from "@supabase/supabase-js";
export const supabase: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// affiliate-schema client. The main `supabase` client defaults to the
// public schema (needed for RPC affiliate_* functions in public + public
// tables like profiles/orders). PostgREST does NOT resolve schema-qualified
// names like "affiliate.promoters" (it treats the dot as part of the table
// name -> 404), so direct reads/writes of affiliate.* tables MUST go
// through this client (db.schema sets the Accept-Profile header).
export const affiliateSupabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: "affiliate" },
});

import Stripe from "stripe";
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

// OpenAI client — lazy so tests / dev without a key still import cleanly.
// Use `getOpenAIClient()` from controllers; the helper returns null when
// OPENAI_API_KEY is unset so callers can gracefully degrade (return null
// suggestions instead of 500'ing).
import OpenAI from "openai";
let cachedOpenAi: OpenAI | null = null;
export function getOpenAIClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!cachedOpenAi) {
    cachedOpenAi = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return cachedOpenAi;
}