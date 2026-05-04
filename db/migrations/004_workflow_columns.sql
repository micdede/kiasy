-- 004_workflow_columns.sql — V2 verwendet created_at/updated_at, V1 hatte created/updated

-- workflows: created_at + updated_at aus alten Spalten ableiten
ALTER TABLE workflows ADD COLUMN created_at TEXT;
ALTER TABLE workflows ADD COLUMN updated_at TEXT;
UPDATE workflows SET created_at = created WHERE created_at IS NULL;
UPDATE workflows SET updated_at = updated WHERE updated_at IS NULL;

-- workflow_steps hatte nie created — neue Spalte mit NOW als Default für Bestehende
ALTER TABLE workflow_steps ADD COLUMN created_at TEXT;
UPDATE workflow_steps SET created_at = datetime('now') WHERE created_at IS NULL;
