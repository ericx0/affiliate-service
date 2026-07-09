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

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),

  LCM_AFFILIATE_SECRET: z.string().min(32, "HMAC secret must be at least 32 chars"),

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

import Stripe from "stripe";
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});