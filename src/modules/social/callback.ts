import { env } from "../../config.js";
import { affiliateSupabase } from "../../config.js";
import { decryptToken, encryptToken } from "./crypto.js";
import type { Platform } from "./oauth.js";

/**
 * OAuth token-exchange + persistence layer.
 *
 * Each platform returns a slightly different shape from /token. The
 * adapter pattern here lets the controller call one `exchangeAndStore`
 * and have it dispatch to the right code path.
 *
 * Tokens are stored encrypted; the row is keyed by (promoter, platform,
 * external_user_id) so a re-connection replaces the existing row.
 */

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number | null;
  scopes: string[];
}

export interface ProfileResponse {
  externalUserId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface TokenExchanger {
  exchangeCodeForToken(code: string, callbackUrl: string): Promise<TokenResponse>;
  fetchProfile(accessToken: string): Promise<ProfileResponse>;
}

/**
 * Exchange the OAuth code, persist the encrypted credentials and basic
 * profile data to social_accounts. Idempotent: a re-connect overwrites
 * the existing row (we keep one credentials row per platform per KOL).
 */
export async function exchangeAndStore(
  platform: Platform,
  promoterId: string,
  code: string,
  callbackUrl: string,
): Promise<{ externalUserId: string; username: string | null }> {
  const exchanger = pickExchanger(platform);
  const tokens = await exchanger.exchangeCodeForToken(code, callbackUrl);
  const profile = await exchanger.fetchProfile(tokens.accessToken);

  await affiliateSupabase
    .from("social_accounts")
    .upsert(
      {
        promoter_id: promoterId,
        platform,
        external_user_id: profile.externalUserId,
        external_username: profile.username,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        access_token_encrypted: encryptToken(tokens.accessToken),
        refresh_token_encrypted: encryptToken(tokens.refreshToken),
        scopes: tokens.scopes,
        expires_at: tokens.expiresInSec
          ? new Date(Date.now() + tokens.expiresInSec * 1000).toISOString()
          : null,
        status: "connected",
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "promoter_id,platform,external_user_id",
      },
    );

  return { externalUserId: profile.externalUserId, username: profile.username };
}

/**
 * Decrypt the stored credentials for a (promoter, platform) row.
 * Returns null if no connected account exists. The platform impl then
 * uses accessToken / refreshToken as needed; if a refresh fails, the
 * caller marks the row as 'expired' and prompts the KOL to re-auth.
 */
export async function loadCredentials(
  promoterId: string,
  platform: Platform,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  externalUserId: string;
  scopes: string[];
} | null> {
  const { data, error } = await affiliateSupabase
    .from("social_accounts")
    .select("access_token_encrypted, refresh_token_encrypted, expires_at, external_user_id, scopes, status")
    .eq("promoter_id", promoterId)
    .eq("platform", platform)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  if (data.status !== "connected" && data.status !== "expiring") return null;

  return {
    accessToken: decryptToken(data.access_token_encrypted),
    refreshToken: decryptToken(data.refresh_token_encrypted ?? ""),
    expiresAt: data.expires_at ? new Date(data.expires_at) : null,
    externalUserId: data.external_user_id,
    scopes: data.scopes ?? [],
  };
}

function pickExchanger(platform: Platform): TokenExchanger {
  switch (platform) {
    case "ig":
    case "fb":
      return metaExchanger();
    case "youtube":
      return googleExchanger();
    case "linkedin":
      return linkedinExchanger();
    case "x":
      return xExchanger();
    case "tiktok":
      return tiktokExchanger();
  }
}

// ============================================================
// Meta (IG + FB)
// ============================================================

function metaExchanger(): TokenExchanger {
  const appId = () => env.META_APP_ID;
  const appSecret = () => env.META_APP_SECRET;
  return {
    async exchangeCodeForToken(code, callbackUrl) {
      const url =
        `https://graph.facebook.com/v20.0/oauth/access_token` +
        `?client_id=${appId()}` +
        `&client_secret=${appSecret()}` +
        `&code=${encodeURIComponent(code)}` +
        `&redirect_uri=${encodeURIComponent(callbackUrl)}`;
      const data = (await fetchJson(url)) as {
        access_token: string;
        token_type?: string;
        expires_in?: number;
      };
      // Meta's long-lived token exchange (extend ~60 days).
      const exchangeUrl =
        `https://graph.facebook.com/v20.0/oauth/access_token` +
        `?grant_type=fb_exchange_token` +
        `&client_id=${appId()}` +
        `&client_secret=${appSecret()}` +
        `&fb_exchange_token=${encodeURIComponent(data.access_token)}`;
      const longLived = (await fetchJson(exchangeUrl)) as {
        access_token: string;
        expires_in?: number;
      };
      return {
        accessToken: longLived.access_token,
        refreshToken: "",
        expiresInSec: longLived.expires_in ?? null,
        scopes: [],
      };
    },
    async fetchProfile(accessToken) {
      const url =
        `https://graph.facebook.com/v20.0/me?fields=id,name,picture{url}` +
        `&access_token=${encodeURIComponent(accessToken)}`;
      const data = (await fetchJson(url)) as {
        id: string;
        name?: string;
        picture?: { data?: { url?: string } };
      };
      return {
        externalUserId: data.id,
        username: data.name ?? null,
        displayName: data.name ?? null,
        avatarUrl: data.picture?.data?.url ?? null,
      };
    },
  };
}

// ============================================================
// Google (YouTube)
// ============================================================

function googleExchanger(): TokenExchanger {
  return {
    async exchangeCodeForToken(code, callbackUrl) {
      const url = "https://oauth2.googleapis.com/token";
      const data = (await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID ?? "",
          client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
          code,
          grant_type: "authorization_code",
          redirect_uri: callbackUrl,
        }).toString(),
      })) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresInSec: data.expires_in ?? null,
        scopes: data.scope?.split(" ").filter(Boolean) ?? [],
      };
    },
    async fetchProfile(accessToken) {
      const url =
        `https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true` +
        `&access_token=${encodeURIComponent(accessToken)}`;
      try {
        const data = (await fetchJson(url)) as {
          items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[];
        };
        const ch = data.items?.[0];
        if (!ch) {
          return { externalUserId: "youtube-self", username: null, displayName: null, avatarUrl: null };
        }
        return {
          externalUserId: ch.id,
          username: ch.snippet.title,
          displayName: ch.snippet.title,
          avatarUrl: ch.snippet.thumbnails?.default?.url ?? null,
        };
      } catch {
        return { externalUserId: "youtube-self", username: null, displayName: null, avatarUrl: null };
      }
    },
  };
}

// ============================================================
// LinkedIn
// ============================================================

function linkedinExchanger(): TokenExchanger {
  return {
    async exchangeCodeForToken(code, callbackUrl) {
      const url = "https://www.linkedin.com/oauth/v2/accessToken";
      const data = (await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: env.LINKEDIN_CLIENT_ID ?? "",
          client_secret: env.LINKEDIN_CLIENT_SECRET ?? "",
          redirect_uri: callbackUrl,
        }).toString(),
      })) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresInSec: data.expires_in ?? null,
        scopes: data.scope?.split(" ").filter(Boolean) ?? [],
      };
    },
    async fetchProfile(accessToken) {
      const url = "https://api.linkedin.com/v2/userinfo";
      const data = (await fetchJson(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })) as { sub?: string; name?: string; picture?: string };
      return {
        externalUserId: data.sub ?? "",
        username: data.name ?? null,
        displayName: data.name ?? null,
        avatarUrl: data.picture ?? null,
      };
    },
  };
}

// ============================================================
// X (Twitter)
// ============================================================

function xExchanger(): TokenExchanger {
  return {
    async exchangeCodeForToken(code, callbackUrl) {
      const url = "https://api.twitter.com/2/oauth2/token";
      const data = (await fetchJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(`${env.X_CLIENT_ID ?? ""}:${env.X_CLIENT_SECRET ?? ""}`).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: env.X_CLIENT_ID ?? "",
          redirect_uri: callbackUrl,
          code_verifier: "challenge",
        }).toString(),
      })) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresInSec: data.expires_in ?? null,
        scopes: data.scope?.split(" ").filter(Boolean) ?? [],
      };
    },
    async fetchProfile(accessToken) {
      const url = "https://api.twitter.com/2/users/me";
      const data = (await fetchJson(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })) as { data?: { id: string; username: string; name?: string; profile_image_url?: string } };
      const u = data.data;
      if (!u) return { externalUserId: "", username: null, displayName: null, avatarUrl: null };
      return {
        externalUserId: u.id,
        username: u.username,
        displayName: u.name ?? u.username,
        avatarUrl: u.profile_image_url ?? null,
      };
    },
  };
}

// ============================================================
// TikTok
// ============================================================

function tiktokExchanger(): TokenExchanger {
  return {
    async exchangeCodeForToken(code, callbackUrl) {
      const url = "https://open.tiktokapis.com/v2/oauth/token/";
      const data = (await fetchJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_key: env.TIKTOK_CLIENT_KEY ?? "",
          client_secret: env.TIKTOK_CLIENT_SECRET ?? "",
          code,
          grant_type: "authorization_code",
          redirect_uri: callbackUrl,
        }).toString(),
      })) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope?: string;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresInSec: data.expires_in,
        scopes: data.scope?.split(",").filter(Boolean) ?? [],
      };
    },
    async fetchProfile(accessToken) {
      const url = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,avatar_url";
      const data = (await fetchJson(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })) as {
        data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } };
      };
      const u = data.data?.user;
      return {
        externalUserId: u?.open_id ?? "",
        username: u?.display_name ?? null,
        displayName: u?.display_name ?? null,
        avatarUrl: u?.avatar_url ?? null,
      };
    },
  };
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}
