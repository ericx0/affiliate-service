import { Request, Response } from "express";
import { z } from "zod";
import { affiliateSupabase } from "../../config.js";
import { env } from "../../config.js";
import { internalError } from "../../utils/controller-error.js";
import { logger } from "../../utils/logger.js";
import { exchangeAndStore, loadCredentials } from "./callback.js";
import { isPlatform, isPendingReview, buildOAuthStart, verifyState, type Platform } from "./oauth.js";
import { fetchMetrics, PlatformNotReadyError, publishPost, ReauthRequiredError } from "./publisher.js";
import { decryptToken } from "./crypto.js";

/**
 * /api/social/* — Multi-platform OAuth + publishing.
 *
 * Routes:
 *   GET  /api/social/accounts              — list connected platforms
 *   GET  /api/social/oauth/:platform/start — kick off OAuth (returns authUrl)
 *   GET  /api/social/oauth/:platform/callback — OAuth redirect
 *   DELETE /api/social/accounts/:platform  — disconnect
 *   POST /api/social/publish               — publish now (single platform)
 *   POST /api/social/schedule              — schedule for later
 *   GET  /api/social/history               — published + scheduled list
 *
 * Auth: every route except the OAuth callback requires a KOL session
 * (set up in social.routes.ts).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(res: Response, code: string, message: string): Response {
  return res.status(400).json({ error: { code, message } });
}

function unauthorized(res: Response, code: string, message: string): Response {
  return res.status(401).json({ error: { code, message } });
}

/* ----------------------------------------------------------------
 * GET /api/social/accounts — list connected platforms for the KOL.
 * Returns one row per platform, including the 'pending_review' status
 * when SOCIAL_PLATFORM_READY hasn't flipped the platform on yet.
 * ---------------------------------------------------------------- */

export async function listMyAccounts(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) {
    return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");
  }

  const { data, error } = await affiliateSupabase
    .from("social_accounts")
    .select("platform, external_user_id, external_username, display_name, avatar_url, scopes, expires_at, connected_at, status")
    .eq("promoter_id", promoterId)
    .order("connected_at", { ascending: false });
  if (error) return internalError(res, "ACCOUNTS_LIST_FAILED", error);

  // Build a union of all 6 platforms; rows without a connected account
  // show status 'not_connected' (or 'pending_review' for the slow ones).
  const byPlatform = new Map<string, unknown>();
  for (const row of data ?? []) {
    byPlatform.set(row.platform as string, row);
  }
  const allPlatforms: Platform[] = ["ig", "tiktok", "fb", "youtube", "linkedin", "x"];
  const shaped = allPlatforms.map((p) => {
    const row = byPlatform.get(p) as any;
    if (!row) {
      return {
        platform: p,
        status: isPendingReview(p) ? "pending_review" : "not_connected",
        displayName: null,
        avatarUrl: null,
        scopes: [],
        connectedAt: null,
        expiresAt: null,
      };
    }
    return {
      platform: p,
      status: row.status,
      displayName: row.display_name,
      username: row.external_username,
      avatarUrl: row.avatar_url,
      scopes: row.scopes ?? [],
      connectedAt: row.connected_at,
      expiresAt: row.expires_at,
    };
  });

  res.json({ data: shaped });
}

/* ----------------------------------------------------------------
 * GET /api/social/oauth/:platform/start
 *
 * KOL clicks "Connect Instagram" → portal calls this → we return the
 * authUrl that the portal redirects to. For platforms still pending
 * review, returns 503 PENDING_REVIEW so the UI can show a banner.
 * ---------------------------------------------------------------- */

export async function oauthStart(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");

  const { platform } = req.params;
  if (!isPlatform(platform)) return badRequest(res, "BAD_PLATFORM", `Unknown platform: ${platform}`);

  if (isPendingReview(platform)) {
    return res.status(503).json({
      error: {
        code: "PENDING_REVIEW",
        message: `${platform} is awaiting platform-side app review. The team will enable it once approved.`,
      },
    });
  }

  const { authUrl } = buildOAuthStart({ platform, promoterId });
  res.json({ data: { authUrl } });
}

/* ----------------------------------------------------------------
 * GET /api/social/oauth/:platform/callback
 *
 * Receives `?code=...&state=...` from the platform, exchanges the
 * code for an access token, fetches the user profile, and stores
 * the encrypted credentials. On success, redirects the KOL back to
 * the accounts page.
 * ---------------------------------------------------------------- */

export async function oauthCallback(req: Request, res: Response) {
  const { platform } = req.params;
  if (!isPlatform(platform)) return badRequest(res, "BAD_PLATFORM", `Unknown platform: ${platform}`);

  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  const errParam = String(req.query.error ?? "");
  if (errParam) {
    return res.redirect(
      `${env.PORTAL_URL || env.APP_URL}/${localeOf(req)}/dashboard/publish/accounts?error=${encodeURIComponent(errParam)}`,
    );
  }
  if (!code || !state) return badRequest(res, "MISSING_CODE", "Missing OAuth code/state");

  const verified = verifyState(state);
  if (!verified) return badRequest(res, "BAD_STATE", "Invalid or expired state token");

  const callbackUrl = `${env.PORTAL_URL || env.APP_URL}/api/social/oauth/${platform}/callback`;
  try {
    await exchangeAndStore(platform, verified.promoterId, code, callbackUrl);
  } catch (err) {
    logger.error({ err: (err as Error).message, platform }, "oauth exchange failed");
    return res.redirect(
      `${env.PORTAL_URL || env.APP_URL}/${localeOf(req)}/dashboard/publish/accounts?error=exchange_failed`,
    );
  }

  res.redirect(
    `${env.PORTAL_URL || env.APP_URL}/${localeOf(req)}/dashboard/publish/accounts?connected=${platform}`,
  );
}

function localeOf(req: Request): string {
  // The OAuth start route was hit from /[locale]/dashboard/...; we
  // round-trip the locale from the referer if present. Default 'en'.
  const ref = req.headers.referer || req.headers.referrer || "";
  const m = String(ref).match(/\/(en|zh|es|ar|ru)\//);
  return m?.[1] ?? "en";
}

/* ----------------------------------------------------------------
 * DELETE /api/social/accounts/:platform — disconnect.
 *
 * Removes the social_accounts row. scheduled_posts in flight will
 * fail on dispatch and surface as 'failed' in the history view.
 * ---------------------------------------------------------------- */

export async function disconnectAccount(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");

  const { platform } = req.params;
  if (!isPlatform(platform)) return badRequest(res, "BAD_PLATFORM", `Unknown platform: ${platform}`);

  const { error } = await affiliateSupabase
    .from("social_accounts")
    .delete()
    .eq("promoter_id", promoterId)
    .eq("platform", platform);
  if (error) return internalError(res, "DISCONNECT_FAILED", error);
  res.status(204).end();
}

/* ----------------------------------------------------------------
 * POST /api/social/publish — publish a single post immediately.
 *
 * Body:
 *   platform       — required, one of the 6
 *   body           — required, post text
 *   mediaUrls[]    — optional, up to N per platform (N=1 for YT/TikTok)
 *   mediaTitle     — optional, for video platforms
 *   language       — optional, ISO code
 *   utmParams      — optional, JSON for funnel attribution
 * ---------------------------------------------------------------- */

const PublishSchema = z.object({
  platform: z.enum(["ig", "tiktok", "fb", "youtube", "linkedin", "x"]),
  body: z.string().min(1).max(5000),
  mediaUrls: z.array(z.string().url().max(500)).max(10).optional(),
  mediaTitle: z.string().max(200).optional(),
  language: z.enum(["en", "zh", "es", "ar", "ru"]).optional(),
  utmParams: z
    .object({
      utm_source: z.string().max(64).optional(),
      utm_medium: z.string().max(64).optional(),
      utm_campaign: z.string().max(64).optional(),
      utm_content: z.string().max(128).optional(),
    })
    .partial()
    .optional(),
}).strict();

export async function publishNow(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");

  const parsed = PublishSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }

  const body = parsed.data;
  const result = await dispatchPublish({
    promoterId,
    platform: body.platform,
    body: body.body,
    mediaUrls: body.mediaUrls ?? [],
    mediaTitle: body.mediaTitle ?? null,
    language: body.language ?? "en",
    utmParams: body.utmParams ?? null,
    scheduledAt: null,
  });

  if ("error" in result) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(201).json({ data: result.data });
}

const ScheduleSchema = PublishSchema.extend({
  scheduledAt: z.string().datetime(),
}).strict();

export async function schedulePost(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");

  const parsed = ScheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const body = parsed.data;
  const schedAt = new Date(body.scheduledAt);
  if (Number.isNaN(schedAt.getTime()) || schedAt.getTime() <= Date.now()) {
    return badRequest(res, "BAD_SCHEDULE_TIME", "scheduledAt must be a future ISO timestamp");
  }

  const { data, error } = await affiliateSupabase
    .from("scheduled_posts")
    .insert({
      promoter_id: promoterId,
      platform: body.platform,
      source_language: body.language ?? "en",
      body: body.body,
      media_urls: body.mediaUrls ?? [],
      media_title: body.mediaTitle ?? null,
      status: "scheduled",
      scheduled_at: schedAt.toISOString(),
      utm_params: (body.utmParams ?? null) as any,
    })
    .select("id, platform, status, scheduled_at, created_at")
    .single();
  if (error) return internalError(res, "SCHEDULE_INSERT_FAILED", error);

  res.status(201).json({ data });
}

/* ----------------------------------------------------------------
 * GET /api/social/history — list scheduled + published posts.
 * Supports ?platform= and ?status= filters.
 * ---------------------------------------------------------------- */

const HistoryQuery = z.object({
  platform: z.enum(["ig", "tiktok", "fb", "youtube", "linkedin", "x"]).optional(),
  status: z
    .enum(["pending", "scheduled", "publishing", "published", "failed"])
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function listHistory(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");

  const parsed = HistoryQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const q = parsed.data;

  let query = affiliateSupabase
    .from("scheduled_posts")
    .select("id, platform, body, media_urls, media_title, status, scheduled_at, published_at, external_post_id, external_url, error_message, created_at, source_language")
    .eq("promoter_id", promoterId)
    .order("created_at", { ascending: false })
    .limit(q.limit);
  if (q.platform) query = query.eq("platform", q.platform);
  if (q.status) query = query.eq("status", q.status);
  if (q.from) query = query.gte("created_at", q.from);
  if (q.to) query = query.lte("created_at", q.to);

  const { data: scheduled, error } = await query;
  if (error) return internalError(res, "HISTORY_LIST_FAILED", error);

  // Augment with metrics from published_posts (joined by external_post_id).
  const externalIds = (scheduled ?? [])
    .map((r) => r.external_post_id)
    .filter((x): x is string => !!x);
  let metricsByPostId = new Map<string, { metrics: Record<string, number>; utm: unknown }>();
  if (externalIds.length > 0) {
    const { data: published } = await affiliateSupabase
      .from("published_posts")
      .select("external_post_id, metrics, utm_params")
      .eq("promoter_id", promoterId)
      .in("external_post_id", externalIds);
    metricsByPostId = new Map(
      (published ?? []).map((p) => [p.external_post_id as string, {
        metrics: (p.metrics as Record<string, number>) ?? {},
        utm: p.utm_params,
      }]),
    );
  }

  const shaped = (scheduled ?? []).map((row) => {
    const metrics = metricsByPostId.get(row.external_post_id as string);
    return {
      id: row.id,
      platform: row.platform,
      status: row.status,
      scheduledAt: row.scheduled_at,
      publishedAt: row.published_at,
      bodyPreview: (row.body as string)?.slice(0, 240) ?? "",
      mediaCount: Array.isArray(row.media_urls) ? row.media_urls.length : 0,
      externalPostId: row.external_post_id,
      externalUrl: row.external_url,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      language: row.source_language,
      metrics: metrics?.metrics ?? null,
      utmParams: metrics?.utm ?? null,
    };
  });

  res.json({ data: shaped });
}

/* ----------------------------------------------------------------
 * POST /api/social/refresh-metrics — refresh engagement stats for
 * a single published post (used by the history view).
 * ---------------------------------------------------------------- */

const RefreshMetricsSchema = z.object({
  postId: z.string().uuid(),
}).strict();

export async function refreshMetrics(req: Request, res: Response) {
  const promoterId = req.promoter?.id;
  if (!promoterId) return unauthorized(res, "UNAUTHORIZED", "Missing promoter context");

  const parsed = RefreshMetricsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.flatten() } });
  }
  const { postId } = parsed.data;
  if (!UUID_RE.test(postId)) return badRequest(res, "BAD_ID", "Invalid post id");

  const { data: post } = await affiliateSupabase
    .from("scheduled_posts")
    .select("platform, external_post_id")
    .eq("id", postId)
    .eq("promoter_id", promoterId)
    .maybeSingle();
  if (!post || !post.external_post_id) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "No published post found" } });
  }

  const creds = await loadCredentials(promoterId, post.platform as Platform);
  if (!creds) {
    return unauthorized(res, "RECONNECT_REQUIRED", `Reconnect ${post.platform} to refresh metrics`);
  }

  try {
    const metrics = await fetchMetrics(post.platform as Platform, creds, post.external_post_id);
    await affiliateSupabase
      .from("published_posts")
      .update({ metrics, last_metrics_sync_at: new Date().toISOString() })
      .eq("promoter_id", promoterId)
      .eq("external_post_id", post.external_post_id);
    res.json({ data: { metrics } });
  } catch (err) {
    if (err instanceof PlatformNotReadyError) {
      return res.status(503).json({ error: { code: "PENDING_REVIEW", message: err.message } });
    }
    if (err instanceof ReauthRequiredError) {
      return unauthorized(res, "RECONNECT_REQUIRED", err.message);
    }
    logger.warn({ err: (err as Error).message }, "metrics refresh failed");
    return internalError(res, "METRICS_REFRESH_FAILED", err);
  }
}

/* ----------------------------------------------------------------
 * Internal dispatcher — used by publishNow() and (eventually) the
 * scheduled-posts cron. Returns a discriminated union; the caller
 * (HTTP layer) maps to status codes.
 * ---------------------------------------------------------------- */

async function dispatchPublish(input: {
  promoterId: string;
  platform: Platform;
  body: string;
  mediaUrls: string[];
  mediaTitle: string | null;
  language: string;
  utmParams: Record<string, string> | null;
  scheduledAt: Date | null;
}): Promise<
  | {
      status: 201;
      data: {
        id: string;
        externalPostId: string;
        externalUrl: string | null;
        status: string;
      };
    }
  | { status: number; error: { code: string; message: string } }
> {
  const creds = await loadCredentials(input.promoterId, input.platform);
  if (!creds) {
    return {
      status: 401,
      error: { code: "RECONNECT_REQUIRED", message: `Connect ${input.platform} first` },
    };
  }

  try {
    const result = await publishPost(input.platform, creds, {
      body: input.body,
      mediaUrls: input.mediaUrls,
      mediaTitle: input.mediaTitle,
      language: input.language,
    });

    // Persist scheduled_posts (acts as the unified log) + published_posts.
    const { data: row, error } = await affiliateSupabase
      .from("scheduled_posts")
      .insert({
        promoter_id: input.promoterId,
        platform: input.platform,
        source_language: input.language,
        body: input.body,
        media_urls: input.mediaUrls,
        media_title: input.mediaTitle,
        status: "published",
        scheduled_at: input.scheduledAt?.toISOString() ?? null,
        published_at: new Date().toISOString(),
        external_post_id: result.externalPostId,
        external_url: result.externalUrl ?? null,
        utm_params: input.utmParams as any,
      })
      .select("id")
      .single();
    if (error) return { status: 500, error: { code: "PUBLISH_LOG_FAILED", message: "Post sent but log insert failed" } };

    await affiliateSupabase.from("published_posts").insert({
      promoter_id: input.promoterId,
      platform: input.platform,
      external_post_id: result.externalPostId,
      external_url: result.externalUrl ?? null,
      utm_params: input.utmParams as any,
      published_at: new Date().toISOString(),
    });

    return {
      status: 201,
      data: {
        id: row.id,
        externalPostId: result.externalPostId,
        externalUrl: result.externalUrl ?? null,
        status: "published",
      },
    };
  } catch (err) {
    if (err instanceof PlatformNotReadyError) {
      return { status: 503, error: { code: "PENDING_REVIEW", message: err.message } };
    }
    if (err instanceof ReauthRequiredError) {
      return { status: 401, error: { code: "RECONNECT_REQUIRED", message: err.message } };
    }
    logger.error({ err: (err as Error).message, platform: input.platform }, "publish failed");
    return { status: 502, error: { code: "PLATFORM_FAILED", message: (err as Error).message } };
  }
}

// Silence unused-import warning when the `decryptToken` is used
// elsewhere; keep it imported for parity with how the OAuth callback
// invokes it via loadCredentials above.
void decryptToken;
