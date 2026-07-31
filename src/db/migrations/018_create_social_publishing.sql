-- ============================================================
-- Migration 018: Multi-platform social publishing (batch 8e-P0 / T1)
-- ============================================================
-- Powers the KOL "Content Publishing" toolbox:
--   - social_accounts : OAuth credentials (encrypted) per KOL per platform
--   - scheduled_posts  : one-row-per-(KOL, platform, attempt) for the
--                        "publish now" and "schedule for later" flows
--   - published_posts  : confirmed external posts + metrics/UTM payload
--
-- Token storage:
--   access_token_encrypted / refresh_token_encrypted hold AES-256-GCM
--   ciphertext with the key derived from SUPABASE_SERVICE_ROLE_KEY. We
--   use the same key shape as the existing notification / Stripe
--   integration — encryption/decryption is centralised in
--   src/modules/social/crypto.ts so KOL tokens never sit in plaintext
--   on the database server.
--
-- RLS:
--   KOLs read their own rows. service_role bypasses RLS for the cron
--   scheduler + metrics syncer.
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Owning KOL. ON DELETE CASCADE so closing the account tears down
  -- every OAuth credential tied to it (GDPR / right-to-erasure).
  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id) ON DELETE CASCADE,

  -- 'ig' | 'tiktok' | 'fb' | 'youtube' | 'linkedin' | 'x'
  platform TEXT NOT NULL CHECK (platform IN (
    'ig', 'tiktok', 'fb', 'youtube', 'linkedin', 'x'
  )),

  -- Platform-side user/account identifier. Combined with (platform,
  -- promoter_id) for the unique key — a KOL connecting the same
  -- platform twice would otherwise create duplicate rows.
  external_user_id TEXT NOT NULL,
  external_username TEXT,
  display_name TEXT,
  avatar_url TEXT,

  -- AES-256-GCM ciphertext, base64 (iv || tag || ciphertext). Empty
  -- string when the platform does not issue a refresh token.
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,

  -- Scopes granted at OAuth time (e.g. ['instagram_basic', 'pages_show_list']).
  scopes TEXT[] DEFAULT '{}'::TEXT[],

  -- Token expiry from the platform's OAuth response. Used by the cron
  -- to refresh before expiry.
  expires_at TIMESTAMPTZ,

  -- Operational status set by the OAuth callback + periodic refresh:
  --   'connected'    — token valid, last refresh succeeded
  --   'expiring'     — expires within 24h, refresh scheduled
  --   'expired'      — refresh failed, KOL must re-authorise
  --   'revoked'      — platform-side disconnect (user pulled OAuth)
  --   'pending_review' — TikTok / YouTube awaiting platform approval;
  --                      OAuth routes return this for KOLs in this state
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'expiring', 'expired', 'revoked', 'pending_review')),

  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (promoter_id, platform, external_user_id)
);

CREATE INDEX idx_social_accounts_promoter
  ON affiliate.social_accounts(promoter_id);

CREATE INDEX idx_social_accounts_platform_status
  ON affiliate.social_accounts(platform, status);

ALTER TABLE affiliate.social_accounts ENABLE ROW LEVEL SECURITY;

-- KOL reads own rows; writes go through service_role (controller layer
-- after kol-auth validates the session).
CREATE POLICY "social_accounts_owner_read" ON affiliate.social_accounts
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = social_accounts.promoter_id
              AND p.email = auth.jwt() ->> 'email')
  );


CREATE TABLE IF NOT EXISTS affiliate.scheduled_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id) ON DELETE CASCADE,

  -- Same platform vocabulary as social_accounts.
  platform TEXT NOT NULL CHECK (platform IN (
    'ig', 'tiktok', 'fb', 'youtube', 'linkedin', 'x'
  )),

  -- Original language of the post body (used to skip redundant
  -- translation passes when the KOL re-shares the same draft).
  source_language TEXT NOT NULL DEFAULT 'en',

  -- Post body — plain text or rich text depending on platform
  -- (linkedin / fb accept HTML; ig / x / tiktok strip it). The
  -- controller-side normaliser applies platform-specific transforms.
  body TEXT NOT NULL,

  -- Image / video URLs the KOL attached. IG/FB/LinkedIn accept a list
  -- of image URLs. YouTube / TikTok use the first entry as the
  -- uploaded video URL. Empty array = text-only post.
  media_urls TEXT[] NOT NULL DEFAULT '{}',

  -- Title for video-first platforms (YT/TikTok/IG Reels).
  media_title TEXT,

  -- 'pending'   — accepted, not yet dispatched
  -- 'scheduled' — scheduled_at set, cron will dispatch
  -- 'publishing'— picked up by cron, in-flight to platform
  -- 'published' — external_post_id set, mirrored to published_posts
  -- 'failed'    — error_message populated; KOL can retry
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'scheduled', 'publishing', 'published', 'failed')),

  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,

  -- Populated by the cron on success.
  external_post_id TEXT,
  external_url TEXT,

  -- Populated on failure (e.g. 401 from platform, rate-limit).
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scheduled_posts_promoter
  ON affiliate.scheduled_posts(promoter_id, created_at DESC);

CREATE INDEX idx_scheduled_posts_dispatch
  ON affiliate.scheduled_posts(status, scheduled_at)
  WHERE status IN ('scheduled', 'pending');

ALTER TABLE affiliate.scheduled_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scheduled_posts_owner_read" ON affiliate.scheduled_posts
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = scheduled_posts.promoter_id
              AND p.email = auth.jwt() ->> 'email')
  );

CREATE POLICY "scheduled_posts_owner_write" ON affiliate.scheduled_posts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = scheduled_posts.promoter_id
              AND p.email = auth.jwt() ->> 'email')
  );


CREATE TABLE IF NOT EXISTS affiliate.published_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,

  -- The platform-side post id. Useful for retrying metric refreshes
  -- without re-reading the scheduled_posts table.
  external_post_id TEXT NOT NULL,

  -- Public permalink the KOL can share. May be null until the platform
  -- finishes indexing the post (IG Reels in particular can take 30s+).
  external_url TEXT,

  -- Engagement metrics snapshot. Shape (loose — each platform fills
  -- what it has):
  --   { likes, comments, shares, impressions, reach, clicks }
  -- Last synced timestamp lives in last_metrics_sync_at.
  metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_metrics_sync_at TIMESTAMPTZ,

  -- UTM params attached at publish time. Used by the funnel dashboard
  -- (T4) to attribute clicks back to a specific post.
  utm_params JSONB,

  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_published_posts_promoter
  ON affiliate.published_posts(promoter_id, published_at DESC);

CREATE INDEX idx_published_posts_platform
  ON affiliate.published_posts(platform, published_at DESC);

ALTER TABLE affiliate.published_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "published_posts_owner_read" ON affiliate.published_posts
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM affiliate.promoters p
            WHERE p.id = published_posts.promoter_id
              AND p.email = auth.jwt() ->> 'email')
  );

NOTIFY pgrst, 'reload schema';
