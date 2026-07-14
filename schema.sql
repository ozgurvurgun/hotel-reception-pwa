-- Golden Gate Istanbul - D1 Database Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('root', 'staff')),
  permissions TEXT DEFAULT '[]',
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  opening_cash REAL DEFAULT 0,
  closing_cash REAL,
  closing_notes TEXT,
  summary_sent INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income', 'agency', 'walk_in')),
  room_number TEXT,
  guest_name TEXT,
  guest_surname TEXT,
  amount REAL DEFAULT 0,
  payment_method TEXT CHECK(payment_method IN ('cash', 'credit_card', 'transfer', 'agency', 'none')),
  agency_name TEXT,
  description TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'credit_card', 'transfer')),
  vendor TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (shift_id) REFERENCES shifts(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

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

CREATE INDEX IF NOT EXISTS idx_transactions_guest ON transactions(guest_name, guest_surname);
CREATE INDEX IF NOT EXISTS idx_transactions_shift ON transactions(shift_id);
CREATE INDEX IF NOT EXISTS idx_transactions_room ON transactions(room_number);
CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(shift_id);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_record_change_logs_entity
  ON record_change_logs(entity_type, entity_id, created_at);
