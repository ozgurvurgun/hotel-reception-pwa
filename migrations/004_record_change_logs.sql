CREATE TABLE IF NOT EXISTS record_change_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('transaction', 'expense')),
  entity_id TEXT NOT NULL,
  shift_id TEXT,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL CHECK(action IN ('created', 'updated', 'deleted')),
  changes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_record_change_logs_entity
  ON record_change_logs(entity_type, entity_id, created_at);
