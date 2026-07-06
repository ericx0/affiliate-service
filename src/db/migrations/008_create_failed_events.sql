-- ============================================================
-- Migration 008: Create affiliate.failed_events table
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.failed_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending',
  -- 'pending' | 'resolved' | 'ignored' | 'retrying'

  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ
);

CREATE INDEX idx_failed_events_status ON affiliate.failed_events(status) WHERE status = 'pending';
CREATE INDEX idx_failed_events_retry ON affiliate.failed_events(next_retry_at) WHERE status = 'retrying';

ALTER TABLE affiliate.failed_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "failed_events_admin_read" ON affiliate.failed_events
  FOR SELECT USING (auth.jwt() ->> 'email' LIKE '%@linkchinamed.com');

NOTIFY pgrst, 'reload schema';