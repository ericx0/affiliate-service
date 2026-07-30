-- ============================================================
-- Migration 013: Create affiliate.cases (anonymized case library)
-- ============================================================
-- Real (anonymized) treatment cases KOLs can reference when prospects ask
-- "has anyone actually done this?". PII is forbidden at the schema level:
-- no name / email / phone columns. Free-form demographics live in
-- age_range + gender + anonymized_data JSONB (no direct identifiers).
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Treatment vertical — mirrors product_category enum so KOLs can cross-
  -- filter the asset library and the case library together.
  treatment_category TEXT NOT NULL,

  -- Hospital/clinic display name (e.g. "Beijing Tiantan Hospital").
  hospital TEXT NOT NULL,

  -- ISO 3166-1 alpha-2 country code where treatment happened.
  country TEXT NOT NULL,

  -- Coarse demographic buckets. NEVER exact ages (PHI minimization).
  age_range TEXT NOT NULL CHECK (age_range IN (
    '0-17', '18-29', '30-44', '45-59', '60-74', '75+'
  )),
  gender TEXT NOT NULL CHECK (gender IN ('female', 'male', 'other', 'undisclosed')),

  -- Patient's country of origin (where they flew from). Distinct from
  -- treatment country; nullable if redundant or unknown.
  origin_country TEXT,

  -- Bilingual narrative. Case library cards show summary; the detail
  -- panel shows outcome. Both required.
  summary_en TEXT NOT NULL,
  summary_zh TEXT,
  outcome_en TEXT NOT NULL,
  outcome_zh TEXT,

  -- JSON blob for non-identifying additional context (timeline,
  -- budget bracket, key turning points). MUST NOT contain PII —
  -- staff are responsible for scrubbing before insert. Free-form shape.
  anonymized_data JSONB DEFAULT '{}'::JSONB,

  -- Approximate cost range (USD, integer cents) — used to anchor the
  -- "case study cost" tile on the case card. NULL = omitted.
  cost_range_low_cents INTEGER,
  cost_range_high_cents INTEGER,

  is_published BOOLEAN NOT NULL DEFAULT false,

  created_by UUID,
  updated_by UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cases_treatment_country
  ON affiliate.cases(treatment_category, country)
  WHERE is_published = true;

CREATE INDEX idx_cases_published
  ON affiliate.cases(is_published, updated_at DESC);

ALTER TABLE affiliate.cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cases_public_read_published" ON affiliate.cases
  FOR SELECT USING (is_published = true);

NOTIFY pgrst, 'reload schema';