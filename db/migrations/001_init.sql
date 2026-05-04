-- kiasy v2 — Initial Schema
-- Wird beim ersten Start von kiasy-core ausgeführt.
-- Migrations-Tracker (siehe Tabelle 'migrations') verhindert doppeltes Ausführen.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ─── Migrations-Tracking ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Messages (Chat-Verlauf, FTS5) ───────────────────────────
CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,             -- Telegram-ID, "mac-app", "monitor"
    role        TEXT NOT NULL,             -- user | assistant | tool | system
    content     TEXT NOT NULL,
    msg_type    TEXT DEFAULT 'text',       -- text | voice | image | tool_use | tool_result
    meta        TEXT,                      -- JSON: Tool-Name, Bilder, Transcript, etc.
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_chat_created ON messages(chat_id, created_at);
CREATE INDEX idx_messages_role         ON messages(role);

CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='id',
    tokenize='unicode61'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- ─── Memory (Faktenliste, FTS5) ──────────────────────────────
CREATE TABLE memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,             -- facts | todos | notes
    key         TEXT,
    value       TEXT NOT NULL,
    data_json   TEXT,                      -- strukturierte Daten optional
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_memory_category ON memory(category);

CREATE VIRTUAL TABLE memory_fts USING fts5(
    value,
    content='memory',
    content_rowid='id',
    tokenize='unicode61'
);
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, value) VALUES (new.id, new.value);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, value) VALUES('delete', old.id, old.value);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, value) VALUES('delete', old.id, old.value);
    INSERT INTO memory_fts(rowid, value) VALUES (new.id, new.value);
    UPDATE memory SET updated_at = datetime('now') WHERE id = new.id;
END;

-- ─── Reminders ───────────────────────────────────────────────
CREATE TABLE reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    text            TEXT NOT NULL,
    due             TEXT NOT NULL,         -- ISO-8601
    chat_id         TEXT NOT NULL,
    done            INTEGER DEFAULT 0,
    type            TEXT DEFAULT 'oneshot',-- oneshot | recurring | task
    interval_hours  REAL,
    fail_count      INTEGER DEFAULT 0,
    last_run        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reminders_due  ON reminders(due, done);
CREATE INDEX idx_reminders_chat ON reminders(chat_id, done);

-- ─── Knowledge Base (FTS-Index, Files in notes/) ─────────────
CREATE TABLE kb_notes (
    filename    TEXT PRIMARY KEY,          -- relativer Pfad in notes/
    title       TEXT,
    tags        TEXT,                      -- comma-separated
    body        TEXT,                      -- Cache des Markdown-Inhalts
    size        INTEGER,
    created_at  TEXT,
    updated_at  TEXT
);
CREATE VIRTUAL TABLE kb_notes_fts USING fts5(
    title, tags, body,
    content='kb_notes',
    content_rowid='rowid',
    tokenize='unicode61'
);
CREATE TRIGGER kb_notes_ai AFTER INSERT ON kb_notes BEGIN
    INSERT INTO kb_notes_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
END;
CREATE TRIGGER kb_notes_ad AFTER DELETE ON kb_notes BEGIN
    INSERT INTO kb_notes_fts(kb_notes_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
END;
CREATE TRIGGER kb_notes_au AFTER UPDATE ON kb_notes BEGIN
    INSERT INTO kb_notes_fts(kb_notes_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
    INSERT INTO kb_notes_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
END;

-- ─── Events (Monitor-Event-Log, 30-Tage-Cleanup) ─────────────
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,             -- info | warn | error | tool | message | health
    message     TEXT NOT NULL,
    meta        TEXT,                      -- JSON
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_type    ON events(type, created_at);

-- ─── Workflows + Steps ───────────────────────────────────────
CREATE TABLE workflows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error | cancelled
    chat_id      TEXT,
    context      TEXT,                     -- JSON
    current_step INTEGER DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_workflows_status ON workflows(status);

CREATE TABLE workflow_steps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    step_num     INTEGER NOT NULL,
    action       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    scheduled    TEXT,                     -- ISO-8601, optional
    condition    TEXT,                     -- Expr, optional
    result       TEXT,                     -- JSON/Text, optional
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_workflow_steps_wf ON workflow_steps(workflow_id, step_num);

-- ─── Tool-Settings ───────────────────────────────────────────
CREATE TABLE tool_settings (
    filename    TEXT PRIMARY KEY,          -- z.B. "memory.js"
    enabled     INTEGER NOT NULL DEFAULT 1,
    visibility  TEXT NOT NULL DEFAULT 'public', -- public | private
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── News-Sources ────────────────────────────────────────────
CREATE TABLE news_sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,             -- api | rss
    name        TEXT NOT NULL,
    url         TEXT NOT NULL,
    api_key     TEXT,
    category    TEXT,
    config      TEXT,                      -- JSON
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Delegations + Sub-Tasks ─────────────────────────────────
CREATE TABLE delegations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    assignee        TEXT NOT NULL,
    assignee_email  TEXT,
    subject         TEXT NOT NULL,
    body            TEXT,
    deadline        TEXT,
    status          TEXT NOT NULL DEFAULT 'open', -- open | done | overdue | cancelled
    followup_days   INTEGER DEFAULT 3,
    last_followup   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_delegations_status ON delegations(status, deadline);

CREATE TABLE delegation_tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    delegation_id   INTEGER NOT NULL REFERENCES delegations(id) ON DELETE CASCADE,
    task            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    completed_at    TEXT
);
CREATE INDEX idx_delegation_tasks_dlg ON delegation_tasks(delegation_id);

-- ─── Labs (Ideen, Tool-Drafts, Experimente) ──────────────────
-- Ersetzt die alte 'roadmap'-Tabelle. Spezifisch auf JARVIS-Selbst-Entwicklung.
CREATE TABLE labs_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT,
    type        TEXT NOT NULL DEFAULT 'idea',  -- idea | draft | experiment | tool
    status      TEXT NOT NULL DEFAULT 'idee',  -- idee | konzept | bauen | live | verworfen
    tool_link   TEXT,                          -- Wenn Idee → Tool wurde: filename in tools/
    notes       TEXT,                          -- Markdown
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_labs_status ON labs_items(status);
CREATE INDEX idx_labs_type   ON labs_items(type);

-- ─── Migration als angewandt markieren ───────────────────────
INSERT INTO migrations(name) VALUES ('001_init');
