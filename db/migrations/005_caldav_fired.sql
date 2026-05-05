-- Anti-Doppelfeuer für CalDAV-Watcher (Cron-Ersatz)
CREATE TABLE IF NOT EXISTS caldav_fired (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uid             TEXT NOT NULL,
  occurrence_iso  TEXT,                  -- für recurring: konkretes Datum; bei Tasks NULL
  fired_at        TEXT NOT NULL DEFAULT (datetime('now')),
  source          TEXT NOT NULL,         -- 'event' oder 'task'
  summary         TEXT,
  action          TEXT,                  -- 'reminder', 'agent', 'tool'
  result          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caldav_fired_unique ON caldav_fired(uid, COALESCE(occurrence_iso, ''));
CREATE INDEX IF NOT EXISTS idx_caldav_fired_at ON caldav_fired(fired_at DESC);
