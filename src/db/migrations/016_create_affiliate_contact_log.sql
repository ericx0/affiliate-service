-- ============================================================
-- Migration 016: Create affiliate.contact_log (KOL <-> client timeline)
-- ============================================================
-- Audit-quality record of every contact touch the KOL has with a client.
-- Private to the KOL — never visible to other promoters, never shown
-- to the customer.
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate.contact_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  client_id UUID NOT NULL REFERENCES affiliate.clients(id) ON DELETE CASCADE,
  promoter_id UUID NOT NULL REFERENCES affiliate.promoters(id),

  -- 'wechat' | 'whatsapp' | 'phone' | 'email' | 'sms' | 'in_person' | 'other'
  channel TEXT NOT NULL,

  -- 'outbound' (KOL reached out) or 'inbound' (customer replied).
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),

  -- Short summary the KOL writes for themselves (≤500 chars enforced in app).
  summary TEXT NOT NULL,

  -- Optional reference to the script the KOL used.
  script_id UUID REFERENCES affiliate.scripts(id),

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contact_log_client
  ON affiliate.contact_log(client_id, occurred_at DESC);

CREATE INDEX idx_contact_log_promoter
  ON affiliate.contact_log(promoter_id, occurred_at DESC);

ALTER TABLE affiliate.contact_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contact_log_owner_read" ON affiliate.contact_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM affiliate.promoters p
      WHERE p.id = contact_log.promoter_id
        AND p.email = auth.jwt() ->> 'email'
    )
  );

CREATE POLICY "contact_log_owner_write" ON affiliate.contact_log
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM affiliate.promoters p
      WHERE p.id = contact_log.promoter_id
        AND p.email = auth.jwt() ->> 'email'
    )
  );

NOTIFY pgrst, 'reload schema';