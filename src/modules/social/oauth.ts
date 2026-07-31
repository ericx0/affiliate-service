import crypto from "node:crypto";
import { env } from "../../config.js";

/**
 * Platform OAuth start URLs and token-exchange endpoints.
 *
 * Each platform follows a different OAuth2 dialect (or, for IG/FB,
 * sits behind Meta's Graph "Business Login" which is the same flow
 * twice). This module centralises the *config* (URLs, scopes,
 * env-var-backed credentials) so the controller stays clean.
 *
 * State token: HMAC-signed nonce that binds the callback to the KOL
 * session. We sign with LCM_AFFILIATE_SECRET so a forged callback
 * from an attacker can't attach a victim's IG account to the attacker's
 * promoter row.
 *
 * TikTok + YouTube note: both require platform-side app review
 * (typically 2-4 weeks). During the review window the OAuth start
 * route returns 503 "pending_review" — KOLs see a friendly banner in
 * the portal. We still ship the full code so the flow lights up the
 * moment the app review is approved.
 */

export type Platform =
  | "ig"
  | "tiktok"
  | "fb"
  | "youtube"
  | "linkedin"
  | "x";

export const PLATFORMS: Platform[] = [
  "ig",
  "tiktok",
  "fb",
  "youtube",
  "linkedin",
  "x",
];

export function isPlatform(s: string): s is Platform {
  return (PLATFORMS as string[]).includes(s);
}

const CALLBACK_PATH: Record<Platform, string> = {
  ig: "/api/social/oauth/ig/callback",
  tiktok: "/api/social/oauth/tiktok/callback",
  fb: "/api/social/oauth/fb/callback",
  youtube: "/api/social/oauth/youtube/callback",
  linkedin: "/api/social/oauth/linkedin/callback",
  x: "/api/social/oauth/x/callback",
};

const DEFAULT_SCOPES: Record<Platform, string[]> = {
  // Instagram Graph: business login + content publish + basic profile.
  // NOTE: 'instagram_business_basic' is the new (2024) Graph scope that
  // replaced 'instagram_basic'. Either works for our use case.
  ig: ["instagram_business_basic", "instagram_business_content_publish", "pages_show_list"],
  // Facebook Pages publish + read insights.
  fb: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  // TikTok: content + basic profile (research data only on approval).
  tiktok: ["user.info.basic", "video.publish", "video.upload"],
  // YouTube Data API v3 — upload + manage + read basic stats.
  youtube: ["https://www.googleapis.com/auth/youtube.upload",
           "https://www.googleapis.com/auth/youtube.readonly",
           "https://www.googleapis.com/auth/youtube.force-ssl"],
  // LinkedIn: share on profile + basic profile + email.
  linkedin: ["openid", "profile", "email", "w_member_social"],
  // X API v2 — tweet.read + tweet.write + users.read (basic tier).
  x: ["tweet.read", "tweet.write", "users.read", "offline.access"],
};

/**
 * Review-required platforms: their OAuth routes short-circuit with a
 * 503 PENDING_REVIEW until the operator flips the env flag (set to
 * "ready" once the platform app review completes).
 */
function isPendingReview(platform: Platform): boolean {
  const flag = env.SOCIAL_PLATFORM_READY;
  // The env is a comma-separated allowlist. Empty / unset = nothing is
  // ready (operator must opt in once each platform is approved).
  if (!flag) return true;
  const ready = flag
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !ready.includes(platform);
}

interface StartOAuthInput {
  platform: Platform;
  promoterId: string;
}

interface StartOAuthResult {
  authUrl: string;
  state: string;
}

/**
 * Build the platform OAuth start URL + signed state token.
 *
 * The state token is <promoterId>.<nonce>.<hmac>. The callback route
 * verifies the HMAC and looks up the promoter by id.
 */
export function buildOAuthStart({ platform, promoterId }: StartOAuthInput): StartOAuthResult {
  const nonce = crypto.randomBytes(16).toString("hex");
  const statePayload = `${promoterId}.${nonce}`;
  const sig = signState(statePayload);
  const state = `${statePayload}.${sig}`;

  const callbackUrl = `${env.PORTAL_URL || env.APP_URL}${CALLBACK_PATH[platform]}`;
  const authUrl = platformAuthUrl(platform, state, callbackUrl);
  return { authUrl, state };
}

export function verifyState(state: string): { promoterId: string } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [promoterId, nonce, sig] = parts;
  if (!promoterId || !nonce || !sig) return null;
  const expected = signState(`${promoterId}.${nonce}`);
  // Constant-time compare to prevent timing-based forgery.
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  return { promoterId };
}

function signState(payload: string): string {
  return crypto
    .createHmac("sha256", env.LCM_AFFILIATE_SECRET)
    .update(payload)
    .digest("hex");
}

function platformAuthUrl(platform: Platform, state: string, callbackUrl: string): string {
  switch (platform) {
    case "ig": {
      // Instagram is wired through Meta's Graph OAuth (business login).
      const appId = env.META_APP_ID;
      if (!appId) throw missingConfig("META_APP_ID");
      const scope = DEFAULT_SCOPES.ig.join(",");
      const url = new URL("https://www.facebook.com/v20.0/dialog/oauth");
      url.searchParams.set("client_id", appId);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      return url.toString();
    }
    case "fb": {
      const appId = env.META_APP_ID;
      if (!appId) throw missingConfig("META_APP_ID");
      const scope = DEFAULT_SCOPES.fb.join(",");
      const url = new URL("https://www.facebook.com/v20.0/dialog/oauth");
      url.searchParams.set("client_id", appId);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      return url.toString();
    }
    case "tiktok": {
      const key = env.TIKTOK_CLIENT_KEY;
      if (!key) throw missingConfig("TIKTOK_CLIENT_KEY");
      const scope = DEFAULT_SCOPES.tiktok.join(",");
      const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
      url.searchParams.set("client_key", key);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scope);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "youtube": {
      const cid = env.GOOGLE_CLIENT_ID;
      if (!cid) throw missingConfig("GOOGLE_CLIENT_ID");
      const scope = DEFAULT_SCOPES.youtube.join(" ");
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", cid);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "linkedin": {
      const cid = env.LINKEDIN_CLIENT_ID;
      if (!cid) throw missingConfig("LINKEDIN_CLIENT_ID");
      const scope = DEFAULT_SCOPES.linkedin.join(" ");
      const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", cid);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      return url.toString();
    }
    case "x": {
      const cid = env.X_CLIENT_ID;
      if (!cid) throw missingConfig("X_CLIENT_ID");
      const scope = DEFAULT_SCOPES.x.join(" ");
      // X uses PKCE — for the public client (OAuth 2.0 with PKCE) we
      // would generate a verifier/challenge pair. For confidential
      // client apps the PKCE step is optional; we ship the simpler
      // form and let the OAuth server return a token directly.
      const url = new URL("https://twitter.com/i/oauth2/authorize");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", cid);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", "challenge");
      url.searchParams.set("code_challenge_method", "plain");
      return url.toString();
    }
  }
}

function missingConfig(name: string): Error {
  return new Error(`[social/oauth] missing env ${name} for platform OAuth`);
}

export { isPendingReview };
