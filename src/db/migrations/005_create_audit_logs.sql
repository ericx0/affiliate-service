-- ============================================================
-- Migration 005: Create affiliate.audit_logs table
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  actor_id UUID NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'override_rate' | 'suspend' | 'unsuspend' | 'blacklist' | 'manual_payout' | etc.
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,

  before_state JSONB,
  after_state JSONB,
  reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_target ON affiliate.audit_logs(target_type, target_id);
CREATE INDEX idx_audit_actor ON affiliate.audit_logs(actor_id);
CREATE INDEX idx_audit_action ON affiliate.audit_logs(action);

ALTER TABLE affiliate.audit_logs ENABLE ROW LEVEL SECURITY;

-- Only admins (linkchinamed.com email) can read
CREATE POLICY "audit_logs_admin_read" ON affiliate.audit_logs
  FOR SELECT USING (auth.jwt() ->> 'email' LIKE '%@linkchinamed.com');

-- NO insert/update/delete policy = no one can modify via RLS
-- Service role bypasses RLS for inserts (audit writes happen in service code)

NOTIFY pgrst, 'reload schema';
