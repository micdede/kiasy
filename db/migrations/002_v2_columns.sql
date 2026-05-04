-- 002_v2_columns.sql — Ergänzt V2-spezifische Spalten zu V1-Tabellen
-- Idempotent durch ALTER TABLE … ADD COLUMN (SQLite ignoriert Duplicate-Errors nicht,
-- darum hier per defensive Sub-Queries via Migration-Runner-Schutz).

-- messages: meta (JSON) für Tool-Calls, Usage, Modell, etc.
ALTER TABLE messages ADD COLUMN meta TEXT;

-- memory: V2 will created_at + updated_at, V1 hatte nur 'added'
ALTER TABLE memory ADD COLUMN created_at TEXT;
ALTER TABLE memory ADD COLUMN updated_at TEXT;

-- Bestehende memory-Zeilen: created_at = added, updated_at = added
UPDATE memory SET created_at = added WHERE created_at IS NULL;
UPDATE memory SET updated_at = added WHERE updated_at IS NULL;
