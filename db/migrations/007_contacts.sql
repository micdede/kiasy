CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  email_work   TEXT,
  email_private TEXT,
  telegram_id  TEXT,
  phone        TEXT,
  notes        TEXT,
  tags         TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS contacts_name ON contacts(name COLLATE NOCASE);
