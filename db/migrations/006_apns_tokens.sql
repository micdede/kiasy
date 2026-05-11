-- APNs Device-Token Registry
-- Ein Token pro physisches Gerät (UNIQUE). Mehrere Geräte möglich.
CREATE TABLE IF NOT EXISTS apns_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL UNIQUE,
  device     TEXT,                                  -- Optional: iPhone-Name o.ä.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used  TEXT
);
