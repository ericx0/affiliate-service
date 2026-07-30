-- ============================================================
-- Migration 012: Create affiliate.scripts (talk-track library)
-- ============================================================
-- Sales scripts for the four documented scenarios in the KOL SOPs:
--   - cold_outreach: how a KOL opens the conversation with a prospect
--   - objection_handling: responses to common "is this safe / legal / real?"
--   - follow_up: the 7-day SOP after first contact
--   - intro: the 30-second elevator pitch
-- industry lets us tag insurance vs. health-content vs. direct KOL posts.
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'cold_outreach' | 'objection_handling' | 'follow_up' | 'intro'
  scenario TEXT NOT NULL CHECK (
    scenario IN ('cold_outreach', 'objection_handling', 'follow_up', 'intro')
  ),

  language TEXT NOT NULL,

  -- 'insurance' | 'kol_post' | 'health_content' | 'general'
  industry TEXT NOT NULL,

  -- Title shown in the library list. Bilingual so the library card
  -- renders without forcing a locale switch.
  title_en TEXT NOT NULL,
  title_zh TEXT,

  -- Bilingual body. At least one must be present (enforced in app).
  content_en TEXT NOT NULL,
  content_zh TEXT,

  -- Day-of-week / day-in-SOP marker for follow_up scripts
  -- (1 = "Day 1 after first contact", 7 = "Day 7 follow-up").
  follow_up_day SMALLINT,

  is_published BOOLEAN NOT NULL DEFAULT false,

  created_by UUID,
  updated_by UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scripts_scenario_lang
  ON affiliate.scripts(scenario, language)
  WHERE is_published = true;

CREATE INDEX idx_scripts_industry_lang
  ON affiliate.scripts(industry, language)
  WHERE is_published = true;

ALTER TABLE affiliate.scripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scripts_public_read_published" ON affiliate.scripts
  FOR SELECT USING (is_published = true);

NOTIFY pgrst, 'reload schema';