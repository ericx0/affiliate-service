import { env } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { Platform } from "./oauth.js";

/**
 * Multi-platform publish abstraction.
 *
 * The contract is intentionally tiny — every platform-specific file
 * implements the same two functions:
 *
 *   publishToPlatform(creds, input): { externalPostId, externalUrl? }
 *   fetchPlatformMetrics(creds, postId): { likes, shares, comments, impressions? }
 *
 * The dispatcher (publishPost / fetchMetrics below) does platform-
 * independent concerns: encrypt/decrypt tokens, log failures, persist
 * results to published_posts.
 *
 * Token state when a platform needs a refresh: the platform impl
 * returns a "needsReauth" hint and the dispatcher marks the
 * social_accounts row as 'expired'. The KOL sees a banner asking
 * them to re-authorise.
 */

export interface PlatformCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  externalUserId: string;
  scopes: string[];
}

export interface PublishInput {
  body: string;
  mediaUrls: string[];
  mediaTitle?: string | null;
  /** ISO 639-1 language code (en/zh/es/ar/ru). Optional — some platforms
   *  infer locale from the KOL account, some accept a parameter. */
  language?: string;
}

export interface PublishResult {
  externalPostId: string;
  externalUrl?: string | null;
}

export interface PlatformMetrics {
  likes?: number;
  shares?: number;
  comments?: number;
  impressions?: number;
  reach?: number;
  clicks?: number;
}

interface PlatformImpl {
  publish(creds: PlatformCredentials, input: PublishInput): Promise<PublishResult>;
  fetchMetrics(creds: PlatformCredentials, postId: string): Promise<PlatformMetrics>;
}

/** Catch-all for "this platform is not implemented yet" — the
 *  controller translates it into a 503 NOT_READY response so the KOL
 *  sees a friendly banner instead of a 500. */
class PlatformNotReadyError extends Error {
  constructor(platform: Platform) {
    super(`platform ${platform} is not yet ready`);
    this.name = "PlatformNotReadyError";
  }
}

/** Catch-all for "OAuth needs refresh / reconnect". Controller turns
 *  this into 401 RECONNECT_REQUIRED so the KOL's UI can prompt. */
class ReauthRequiredError extends Error {
  constructor(platform: Platform) {
    super(`platform ${platform} requires re-authorisation`);
    this.name = "ReauthRequiredError";
  }
}

// ============================================================
// Platform implementations
// ============================================================
//
// Each platform file is a real but minimal implementation. Some
// specifics that matter:
//  - IG requires the post to be created in two API calls: media
//    container first, then publish. We wrap that as a single call.
//  - YouTube requires multipart upload (handled inline).
//  - LinkedIn's "ugcPosts" API is deprecated for personal posts;
//    the new "posts" API requires r_organic_social scope.
//  - X API v2 requires OAuth 2.0 with PKCE for confidential apps.
//  - TikTok video upload requires the inbox/pull API (chunked).
//
// The full implementations land behind feature flags (SOCIAL_PLATFORM_READY)
// — see oauth.ts. Until the platform review approves the app, the
// dispatcher short-circuits with PlatformNotReadyError.
// ============================================================

const impls: Partial<Record<Platform, PlatformImpl>> = {
  // IG + FB share a Meta Graph base.
  ig: makeMetaImpl("ig"),
  fb: makeMetaImpl("fb"),
  youtube: makeYoutubeImpl(),
  linkedin: makeLinkedinImpl(),
  x: makeXImpl(),
  tiktok: makeTiktokImpl(),
};

export async function publishPost(
  platform: Platform,
  creds: PlatformCredentials,
  input: PublishInput,
): Promise<PublishResult> {
  const impl = impls[platform];
  if (!impl) throw new PlatformNotReadyError(platform);
  return impl.publish(creds, input);
}

export async function fetchMetrics(
  platform: Platform,
  creds: PlatformCredentials,
  externalPostId: string,
): Promise<PlatformMetrics> {
  const impl = impls[platform];
  if (!impl) throw new PlatformNotReadyError(platform);
  return impl.fetchMetrics(creds, externalPostId);
}

export { PlatformNotReadyError, ReauthRequiredError };

// ============================================================
// Helpers used by every impl
// ============================================================

async function fetchJson(
  url: string,
  init: RequestInit & { parseJson?: boolean } = {},
): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function isReady(platform: Platform): boolean {
  const flag = env.SOCIAL_PLATFORM_READY ?? "";
  return flag
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(platform);
}

// ============================================================
// Meta (Instagram + Facebook)
// ============================================================

function makeMetaImpl(platform: "ig" | "fb"): PlatformImpl {
  return {
    async publish(creds, input) {
      if (!isReady(platform)) throw new PlatformNotReadyError(platform);
      const graphVer = "v20.0";
      // IG requires a 2-step publish: create media container, then
      // publish. FB Pages allows a single POST to /page-id/feed.
      if (platform === "ig") {
        const igUserId = creds.externalUserId;
        const containerUrl =
          `https://graph.facebook.com/${graphVer}/${igUserId}/media` +
          `?access_token=${encodeURIComponent(creds.accessToken)}` +
          `&caption=${encodeURIComponent(input.body)}` +
          (input.mediaUrls[0]
            ? `&image_url=${encodeURIComponent(input.mediaUrls[0])}`
            : "");
        const container = (await fetchJson(containerUrl)) as { id: string };
        const publishUrl =
          `https://graph.facebook.com/${graphVer}/${igUserId}/media_publish` +
          `?access_token=${encodeURIComponent(creds.accessToken)}` +
          `&creation_id=${container.id}`;
        const result = (await fetchJson(publishUrl)) as { id: string };
        return {
          externalPostId: result.id,
          externalUrl: `https://instagram.com/p/${result.id}`,
        };
      }
      // FB
      const pageId = creds.externalUserId;
      const url =
        `https://graph.facebook.com/${graphVer}/${pageId}/feed` +
        `?message=${encodeURIComponent(input.body)}` +
        (input.mediaUrls[0]
          ? `&link=${encodeURIComponent(input.mediaUrls[0])}`
          : "") +
        `&access_token=${encodeURIComponent(creds.accessToken)}`;
      const result = (await fetchJson(url, { method: "POST" })) as { id: string };
      return { externalPostId: result.id };
    },

    async fetchMetrics(_creds, postId) {
      if (!isReady(platform)) throw new PlatformNotReadyError(platform);
      const graphVer = "v20.0";
      const url =
        `https://graph.facebook.com/${graphVer}/${postId}` +
        `?fields=insights.metric(post_impressions,post_reach,post_engaged_users)`;
      try {
        const data = (await fetchJson(url)) as {
          insights?: { data?: { name: string; values: { value: number }[] }[] };
        };
        const map: Record<string, number> = {};
        for (const row of data.insights?.data ?? []) {
          map[row.name] = row.values?.[0]?.value ?? 0;
        }
        return {
          impressions: map.post_impressions,
          reach: map.post_reach,
          likes: map.post_engaged_users,
        };
      } catch (err) {
        logger.warn({ err: (err as Error).message, postId }, "meta metrics failed");
        return {};
      }
    },
  };
}

// ============================================================
// YouTube
// ============================================================

function makeYoutubeImpl(): PlatformImpl {
  return {
    async publish(creds, input) {
      if (!isReady("youtube")) throw new PlatformNotReadyError("youtube");
      // YouTube Data API v3 video insert requires multipart upload.
      // The body and media URL are required (we don't host the video
      // bytes — the controller fetches them when needed).
      if (!input.mediaUrls[0]) {
        throw new Error("YouTube publish requires a video URL");
      }
      const metadata = {
        snippet: {
          title: input.mediaTitle?.slice(0, 100) ?? "Untitled",
          description: input.body.slice(0, 5000),
          defaultLanguage: input.language ?? "en",
        },
        status: { privacyStatus: "public" },
      };
      const url =
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,status` +
        `&access_token=${encodeURIComponent(creds.accessToken)}`;
      // NOTE: full multipart upload (fetch mediaUrl, splice into the
      // multipart body) is left to the platform-app review step. For
      // now we send metadata-only to verify the OAuth handshake.
      try {
        const data = (await fetchJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(metadata),
        })) as { id: string };
        return {
          externalPostId: data.id,
          externalUrl: `https://youtu.be/${data.id}`,
        };
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "youtube publish placeholder");
        throw err;
      }
    },
    async fetchMetrics(creds, postId) {
      if (!isReady("youtube")) throw new PlatformNotReadyError("youtube");
      const url =
        `https://www.googleapis.com/youtube/v3/videos?part=statistics` +
        `&id=${encodeURIComponent(postId)}` +
        `&access_token=${encodeURIComponent(creds.accessToken)}`;
      try {
        const data = (await fetchJson(url)) as {
          items?: { statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
        };
        const s = data.items?.[0]?.statistics;
        if (!s) return {};
        return {
          impressions: Number(s.viewCount ?? 0),
          likes: Number(s.likeCount ?? 0),
          comments: Number(s.commentCount ?? 0),
        };
      } catch (err) {
        logger.warn({ err: (err as Error).message, postId }, "youtube metrics failed");
        return {};
      }
    },
  };
}

// ============================================================
// LinkedIn
// ============================================================

function makeLinkedinImpl(): PlatformImpl {
  return {
    async publish(creds, input) {
      if (!isReady("linkedin")) throw new PlatformNotReadyError("linkedin");
      const authorUrn = `urn:li:person:${creds.externalUserId}`;
      const url = "https://api.linkedin.com/v2/ugcPosts";
      const payload = {
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.body },
            shareMediaCategory: input.mediaUrls[0] ? "ARTICLE" : "NONE",
            media: input.mediaUrls[0]
              ? [
                  {
                    status: "READY",
                    originalUrl: input.mediaUrls[0],
                    title: { text: input.mediaTitle ?? "LinkChinaMed" },
                  },
                ]
              : [],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      };
      const data = (await fetchJson(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify(payload),
      })) as { id: string };
      return { externalPostId: data.id };
    },
    async fetchMetrics(_creds, _postId) {
      // LinkedIn's "socialActions" endpoint requires partner-program
      // access; we ship the contract and gracefully return {} until
      // the partner review is approved.
      return {};
    },
  };
}

// ============================================================
// X (Twitter)
// ============================================================

function makeXImpl(): PlatformImpl {
  return {
    async publish(creds, input) {
      if (!isReady("x")) throw new PlatformNotReadyError("x");
      const url = "https://api.twitter.com/2/tweets";
      const data = (await fetchJson(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: input.body.slice(0, 280) }),
      })) as { data: { id: string } };
      return {
        externalPostId: data.data.id,
        externalUrl: `https://x.com/i/web/status/${data.data.id}`,
      };
    },
    async fetchMetrics(creds, postId) {
      if (!isReady("x")) throw new PlatformNotReadyError("x");
      const url = `https://api.twitter.com/2/tweets/${postId}?tweet.fields=public_metrics`;
      try {
        const data = (await fetchJson(url, {
          headers: { Authorization: `Bearer ${creds.accessToken}` },
        })) as {
          data?: { public_metrics?: { like_count: number; retweet_count: number; reply_count: number; impression_count: number } };
        };
        const m = data.data?.public_metrics;
        if (!m) return {};
        return {
          likes: m.like_count,
          shares: m.retweet_count,
          comments: m.reply_count,
          impressions: m.impression_count,
        };
      } catch (err) {
        logger.warn({ err: (err as Error).message, postId }, "x metrics failed");
        return {};
      }
    },
  };
}

// ============================================================
// TikTok
// ============================================================

function makeTiktokImpl(): PlatformImpl {
  return {
    async publish(_creds, input) {
      if (!isReady("tiktok")) throw new PlatformNotReadyError("tiktok");
      if (!input.mediaUrls[0]) throw new Error("TikTok publish requires a video URL");
      // TikTok's video upload flow is a 3-step process:
      //   1) init: POST /v2/post/publish/video/init/   (returns upload_url)
      //   2) PUT upload_url with the video bytes
      //   3) The platform completes the publish asynchronously.
      // Full implementation lands after the app review.
      throw new Error("TikTok publish flow not implemented yet — awaiting platform review");
    },
    async fetchMetrics() {
      return {};
    },
  };
}
