-- ============================================================
-- Migration 017: Auto-create followup_tasks on clients INSERT
-- ============================================================
-- The KOL portal calls POST /api/affiliate/clients to register a new
-- customer. We want the 7-day SOP tasks (Day 0 confirm, Day 1 check-in,
-- Day 3 value-share, Day 7 follow-up) to appear immediately, without the
-- portal or controller having to remember to insert them.
--
-- Doing this in a trigger (rather than in the controller) means:
--   1. The invariant holds for backfills / SQL inserts too, not just
--      API-created rows.
--   2. The API stays simple — INSERT, get the client id, done.
--   3. Tests can exercise the SOP seed by inserting directly.
--
-- Day 0 fires immediately (NOW()); the rest are NOW() + day offset.
-- All four use the existing followup_tasks table (migration 015). The
-- task_type values mirror the canonical SOP vocabulary already used by
-- the dashboard UI.
-- ============================================================

CREATE OR REPLACE FUNCTION affiliate.fn_create_default_followup_tasks()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO affiliate.followup_tasks (client_id, promoter_id, day, task_type, due_at)
  VALUES
    (NEW.id, NEW.promoter_id, 0, 'intro',     NOW()),
    (NEW.id, NEW.promoter_id, 1, 'check_in',  NOW() + INTERVAL '1 day'),
    (NEW.id, NEW.promoter_id, 3, 'proposal',  NOW() + INTERVAL '3 days'),
    (NEW.id, NEW.promoter_id, 7, 'close',     NOW() + INTERVAL '7 days');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clients_auto_followup_tasks ON affiliate.clients;

CREATE TRIGGER trg_clients_auto_followup_tasks
  AFTER INSERT ON affiliate.clients
  FOR EACH ROW
  EXECUTE FUNCTION affiliate.fn_create_default_followup_tasks();

NOTIFY pgrst, 'reload schema';