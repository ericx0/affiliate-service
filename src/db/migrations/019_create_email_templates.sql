-- ============================================================
-- Migration 019: Email/DM templates (batch 8e-P0 / T3)
-- ============================================================
-- Powers the KOL "Email templates" toolbox page. Templates are
-- categorised by purpose (dm_invite / follow_up / service_pitch /
-- case_share) and localised to one of the 5 shipping languages
-- (en / zh / es / ar / ru).
--
-- One row per (category, language) pair — 4 categories x 5 langs =
-- 20 templates total. Seeding is done in 020_email_templates_seed.sql.
--
-- Each template carries a subject (for email) and a body that the
-- KOL can use as a DM (subject dropped). Variables use the {{name}}
-- placeholder form so the portal can do a one-shot replace before
-- the KOL hits "send".
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'dm_invite'      — first-touch DM to a cold prospect
  -- 'follow_up'      — Day-1 / Day-3 follow-up after first contact
  -- 'service_pitch'  — value-driven recommendation of LCM services
  -- 'case_share'     — anonymised case study to demonstrate outcomes
  category TEXT NOT NULL CHECK (category IN (
    'dm_invite', 'follow_up', 'service_pitch', 'case_share'
  )),

  language TEXT NOT NULL CHECK (language IN ('en', 'zh', 'es', 'ar', 'ru')),

  -- Short label shown in the templates list (and used as the
  -- {{title}} variable so the KOL can reference "my fertility
  -- follow-up #1" in a thread).
  title TEXT NOT NULL,

  -- Email subject line. Ignored when the KOL sends via DM (the
  -- subject field on those platforms doesn't exist) but kept for
  -- parity — both surfaces read the same row.
  subject TEXT NOT NULL,

  -- Plain-text body with {{variable}} placeholders. Supported vars:
  --   {{kol_name}}     — KOL's display name
  --   {{prospect_name}} — first name / handle the KOL types in
  --   {{case_link}}    — LCM case-study URL
  --   {{booking_link}} — LCM pre-review form URL
  --   {{referral_link}}— KOL's referral URL with UTM tags
  body TEXT NOT NULL,

  -- Variant tag (e.g. 'fertility', 'oncology'). KOLs can filter by
  -- the vertical they're promoting to keep the list short.
  variant TEXT,

  is_published BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_templates_category_lang
  ON affiliate.email_templates(category, language)
  WHERE is_published = true;

CREATE INDEX idx_email_templates_variant
  ON affiliate.email_templates(variant)
  WHERE variant IS NOT NULL;

ALTER TABLE affiliate.email_templates ENABLE ROW LEVEL SECURITY;

-- KOLs read all published templates (the same RLS shape as the
-- asset/script/case library). Writes go through service_role only.
CREATE POLICY "email_templates_public_read_published" ON affiliate.email_templates
  FOR SELECT USING (is_published = true);

NOTIFY pgrst, 'reload schema';
