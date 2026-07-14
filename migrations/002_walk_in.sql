-- Migration 002: walk_in entry type
PRAGMA foreign_keys=OFF;

CREATE TABLE transactions_new (
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

INSERT INTO transactions_new SELECT * FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX IF NOT EXISTS idx_transactions_guest ON transactions(guest_name, guest_surname);
CREATE INDEX IF NOT EXISTS idx_transactions_shift ON transactions(shift_id);
CREATE INDEX IF NOT EXISTS idx_transactions_room ON transactions(room_number);

PRAGMA foreign_keys=ON;
