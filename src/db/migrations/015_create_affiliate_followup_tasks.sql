-- ============================================================
-- Migration 015: Create affiliate.followup_tasks (7-day SOP)
-- ============================================================
-- A scheduled task per client for the KOL's 7-day follow-up sequence.
-- The cron job picks up tasks where due_at <= NOW() and emits a
-- reminder (the KOL sees it as a banner on /dashboard).
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.followup_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  client_id UUID NOT NULL REFERENCES affiliate.clients(id) ON DELETE CASCADE,
  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id),

  -- Day in the 7-day SOP (1..7). Day 0 = same-day confirmation.
  day SMALLINT NOT NULL CHECK (day BETWEEN 0 AND 30),

  -- 'day_0_confirm' | 'day_1_check_in' | 'day_3_value_share' |
  -- 'day_7_follow_up' | 'custom'. Custom = KOL set a one-off reminder.
  task_type TEXT NOT NULL,

  -- Suggested copy the KOL can send (one-click copy from the dashboard).
  -- Filled by the portal from affiliate.scripts on insert.
  suggested_script_id UUID REFERENCES affiliate.scripts(id),

  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tasks_promoter_due
  ON affiliate.followup_tasks(promoter_id, due_at)
  WHERE completed_at IS NULL AND dismissed_at IS NULL;

CREATE INDEX idx_tasks_client
  ON affiliate.followup_tasks(client_id, due_at);

ALTER TABLE affiliate.followup_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks_owner_read" ON affiliate.followup_tasks
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM affiliate.promoters p
      WHERE p.id = followup_tasks.promoter_id
        AND p.email = auth.jwt() ->> 'email'
    )
  );

CREATE POLICY "tasks_owner_write" ON affiliate.followup_tasks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM affiliate.promoters p
      WHERE p.id = followup_tasks.promoter_id
        AND p.email = auth.jwt() ->> 'email'
    )
  );

NOTIFY pgrst, 'reload schema';