-- ============================================================
-- Migration 011: Create affiliate.assets (marketing asset library)
-- ============================================================
-- Powers the KOL "Library > Assets" tab. Staff-only writes; KOLs read
-- anything marked is_published. Indexed for the typical filter combinations
-- used by the portal: kind + language + product_category.
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'video' | 'image' | 'copy' (social copy / caption text).
  kind TEXT NOT NULL CHECK (kind IN ('video', 'image', 'copy')),

  -- ISO 639-1 codes we actually publish in: en, zh, ru, es, ar.
  language TEXT NOT NULL,

  -- Mirrors the public site product_category enum so KOLs can filter
  -- by the same vertical they promote (e.g. 'fertility', 'oncology').
  product_category TEXT NOT NULL,

  -- Bilingual titles: KOLs in any locale see a non-empty label.
  title_en TEXT NOT NULL,
  title_zh TEXT,

  -- For video/image: a signed URL on the assets CDN bucket.
  -- For copy: the full caption/post body (text).
  content_url TEXT NOT NULL,

  -- Optional preview thumbnail (images/videos) or hero card (copy).
  thumbnail_url TEXT,

  -- Free-form tags: campaign tags, audience segments, etc.
  tags TEXT[] DEFAULT '{}'::TEXT[],

  is_published BOOLEAN NOT NULL DEFAULT false,

  -- Audit (admin-v2 staff writes these rows).
  created_by UUID,
  updated_by UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assets_kind_lang_cat
  ON affiliate.assets(kind, language, product_category)
  WHERE is_published = true;

CREATE INDEX idx_assets_published
  ON affiliate.assets(is_published, updated_at DESC);

ALTER TABLE affiliate.assets ENABLE ROW LEVEL SECURITY;

-- KOLs (and the public) can only read rows that are published.
CREATE POLICY "assets_public_read_published" ON affiliate.assets
  FOR SELECT USING (is_published = true);

-- Writes are service-role / admin only. The portal never writes here
-- directly; admin-v2 staff write via the service-role Supabase client.

NOTIFY pgrst, 'reload schema';