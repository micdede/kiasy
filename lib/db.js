// lib/db.js — Zentrale SQLite-Datenbank für JARVIS
// Vereint: Messages (ex chat-db), Memory, Reminders, Knowledge-Index, Events
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "jarvis.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// ============================================================
// Schema erstellen
// ============================================================

db.exec(`
  -- Messages (übernommen aus chat-history.db)
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    text_preview TEXT DEFAULT '',
    msg_type    TEXT DEFAULT 'text',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, id);

  -- Memory (ersetzt memory.json)
  CREATE TABLE IF NOT EXISTS memory (
    id        INTEGER PRIMARY KEY,
    category  TEXT NOT NULL CHECK(category IN ('facts','todos','notes')),
    key       TEXT,
    value     TEXT,
    added     TEXT DEFAULT (date('now','localtime')),
    data_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);

  -- Reminders (ersetzt reminders.json)
  CREATE TABLE IF NOT EXISTS reminders (
    id             INTEGER PRIMARY KEY,
    text           TEXT NOT NULL,
    due            TEXT NOT NULL,
    chat_id        TEXT,
    done           INTEGER DEFAULT 0,
    created        TEXT DEFAULT (datetime('now','localtime')),
    type           TEXT DEFAULT 'text',
    interval_hours REAL,
    fail_count     INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(done, due);

  -- Knowledge Base Index (Dateien bleiben Source of Truth)
  CREATE TABLE IF NOT EXISTS kb_notes (
    filename   TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    tags       TEXT DEFAULT '',
    created    TEXT,
    updated    TEXT,
    size       INTEGER DEFAULT 0,
    body       TEXT DEFAULT '',
    indexed_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Events Log (ersetzt In-Memory-Only)
  CREATE TABLE IF NOT EXISTS events (
    id        TEXT PRIMARY KEY,
    type      TEXT NOT NULL,
    message   TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

  -- Terminal Session (letzte Session persistieren)
  CREATE TABLE IF NOT EXISTS terminal_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK(type IN ('cmd','stdout','stderr','error','info')),
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS terminal_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Roadmap / ToDo-Board
  CREATE TABLE IF NOT EXISTS roadmap (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT DEFAULT 'idea' CHECK(status IN ('idea','planned','in_progress','done')),
    priority    TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
    category    TEXT DEFAULT '',
    created     TEXT DEFAULT (datetime('now','localtime')),
    updated     TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Delegierte Aufgaben
  CREATE TABLE IF NOT EXISTS delegations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    assignee        TEXT NOT NULL,
    assignee_email  TEXT NOT NULL,
    context         TEXT DEFAULT 'work' CHECK(context IN ('work','private')),
    subject         TEXT NOT NULL,
    deadline        TEXT,
    followup_days   INTEGER DEFAULT 3,
    last_followup   TEXT,
    next_followup   TEXT,
    status          TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','done','cancelled')),
    created         TEXT DEFAULT (datetime('now','localtime')),
    updated         TEXT DEFAULT (datetime('now','localtime')),
    completed_at    TEXT,
    chat_id         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);
  CREATE INDEX IF NOT EXISTS idx_delegations_followup ON delegations(next_followup);

  CREATE TABLE IF NOT EXISTS delegation_tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    delegation_id INTEGER NOT NULL,
    task          TEXT NOT NULL,
    status        TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
    completed_at  TEXT,
    FOREIGN KEY (delegation_id) REFERENCES delegations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_deltasks_delegation ON delegation_tasks(delegation_id);

  -- Tool Settings (Enable/Disable)
  CREATE TABLE IF NOT EXISTS tool_settings (
    filename   TEXT PRIMARY KEY,
    enabled    INTEGER DEFAULT 1,
    visibility TEXT DEFAULT 'private' CHECK(visibility IN ('private','public')),
    updated    TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Workflows (Agentic Loops)
  CREATE TABLE IF NOT EXISTS workflows (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    status       TEXT DEFAULT 'running' CHECK(status IN ('running','paused','completed','failed','cancelled')),
    chat_id      TEXT,
    context      TEXT DEFAULT '{}',
    created      TEXT DEFAULT (datetime('now','localtime')),
    updated      TEXT DEFAULT (datetime('now','localtime')),
    current_step INTEGER DEFAULT 0,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);

  CREATE TABLE IF NOT EXISTS workflow_steps (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id   TEXT NOT NULL,
    step_num      INTEGER NOT NULL,
    action        TEXT NOT NULL,
    status        TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
    scheduled     TEXT,
    delay_minutes INTEGER,
    condition     TEXT,
    result        TEXT,
    started_at    TEXT,
    completed_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wfsteps_workflow ON workflow_steps(workflow_id, step_num);
  CREATE INDEX IF NOT EXISTS idx_wfsteps_pending ON workflow_steps(status, scheduled);
`);

// FTS5 Tabellen + Sync-Triggers
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text_preview, content='messages', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text_preview) VALUES (new.id, new.text_preview);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_preview) VALUES('delete', old.id, old.text_preview);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_preview) VALUES('delete', old.id, old.text_preview);
      INSERT INTO messages_fts(rowid, text_preview) VALUES (new.id, new.text_preview);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key, value, content='memory', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
      INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS reminders_fts USING fts5(text, content='reminders', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS reminders_ai AFTER INSERT ON reminders BEGIN
      INSERT INTO reminders_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS reminders_ad AFTER DELETE ON reminders BEGIN
      INSERT INTO reminders_fts(reminders_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS reminders_au AFTER UPDATE ON reminders BEGIN
      INSERT INTO reminders_fts(reminders_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO reminders_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_notes_fts USING fts5(title, tags, body, content='kb_notes', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS kb_notes_ai AFTER INSERT ON kb_notes BEGIN
      INSERT INTO kb_notes_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_notes_ad AFTER DELETE ON kb_notes BEGIN
      INSERT INTO kb_notes_fts(kb_notes_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS kb_notes_au AFTER UPDATE ON kb_notes BEGIN
      INSERT INTO kb_notes_fts(kb_notes_fts, rowid, title, tags, body) VALUES('delete', old.rowid, old.title, old.tags, old.body);
      INSERT INTO kb_notes_fts(rowid, title, tags, body) VALUES (new.rowid, new.title, new.tags, new.body);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(message, content='events', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, message) VALUES (new.rowid, new.message);
    END;
    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, message) VALUES('delete', old.rowid, old.message);
    END;
  `);
} catch (e) {
  console.warn("[DB] FTS5 Setup-Warnung:", e.message);
}

// ============================================================
// Prepared Statements
// ============================================================

// --- Messages ---
const msg = {
  insert: db.prepare("INSERT INTO messages (chat_id, role, content, text_preview, msg_type) VALUES (?, ?, ?, ?, ?)"),
  recent: db.prepare("SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?"),
  search: db.prepare("SELECT m.id, m.chat_id, m.role, m.text_preview, m.created_at FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? ORDER BY f.rank LIMIT ?"),
  context: db.prepare("SELECT role, text_preview, created_at FROM messages WHERE chat_id = ? AND id BETWEEN ? - 1 AND ? + 1 ORDER BY id"),
  clearChat: db.prepare("DELETE FROM messages WHERE chat_id = ?"),
  clearAll: db.prepare("DELETE FROM messages"),
  stats: db.prepare("SELECT COUNT(*) as total, COUNT(DISTINCT chat_id) as chats, MIN(created_at) as oldest, MAX(created_at) as newest FROM messages"),
};

// --- Memory ---
const mem = {
  all: db.prepare("SELECT id, category, key, value, added, data_json FROM memory ORDER BY id"),
  byCategory: db.prepare("SELECT id, category, key, value, added, data_json FROM memory WHERE category = ? ORDER BY id"),
  insert: db.prepare("INSERT INTO memory (id, category, key, value, added, data_json) VALUES (?, ?, ?, ?, ?, ?)"),
  remove: db.prepare("DELETE FROM memory WHERE id = ?"),
  update: db.prepare("UPDATE memory SET key = ?, value = ?, data_json = ? WHERE id = ?"),
  search: db.prepare("SELECT m.id, m.category, m.key, m.value, m.added FROM memory_fts f JOIN memory m ON m.id = f.rowid WHERE memory_fts MATCH ? ORDER BY f.rank LIMIT ?"),
};

// --- Reminders ---
const rem = {
  all: db.prepare("SELECT * FROM reminders ORDER BY due"),
  active: db.prepare("SELECT * FROM reminders WHERE done = 0 ORDER BY due"),
  due: db.prepare("SELECT * FROM reminders WHERE done = 0 AND due <= datetime('now','localtime') AND fail_count < 3"),
  insert: db.prepare("INSERT INTO reminders (id, text, due, chat_id, done, created, type, interval_hours, fail_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  update: db.prepare("UPDATE reminders SET text=?, due=?, chat_id=?, done=?, type=?, interval_hours=?, fail_count=? WHERE id=?"),
  markDone: db.prepare("UPDATE reminders SET done = 1 WHERE id = ?"),
  advance: db.prepare("UPDATE reminders SET due = ?, fail_count = 0 WHERE id = ?"),
  incFail: db.prepare("UPDATE reminders SET fail_count = fail_count + 1 WHERE id = ?"),
  getFail: db.prepare("SELECT fail_count FROM reminders WHERE id = ?"),
  remove: db.prepare("DELETE FROM reminders WHERE id = ?"),
  getById: db.prepare("SELECT * FROM reminders WHERE id = ?"),
};

// --- Knowledge Base ---
const kb = {
  upsert: db.prepare("INSERT OR REPLACE INTO kb_notes (filename, title, tags, created, updated, size, body) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  remove: db.prepare("DELETE FROM kb_notes WHERE filename = ?"),
  all: db.prepare("SELECT filename, title, tags, created, updated, size FROM kb_notes ORDER BY updated DESC"),
  search: db.prepare("SELECT n.filename, n.title, n.tags, n.updated, snippet(kb_notes_fts, 2, '»', '«', '…', 40) as context FROM kb_notes_fts f JOIN kb_notes n ON n.rowid = f.rowid WHERE kb_notes_fts MATCH ? ORDER BY f.rank LIMIT ?"),
};

// --- Events ---
const evt = {
  insert: db.prepare("INSERT INTO events (id, type, message, timestamp) VALUES (?, ?, ?, ?)"),
  recent: db.prepare("SELECT * FROM events ORDER BY timestamp DESC LIMIT ?"),
  since: db.prepare("SELECT * FROM events WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?"),
  cleanup: db.prepare("DELETE FROM events WHERE timestamp < datetime('now', '-30 days')"),
  search: db.prepare("SELECT e.id, e.type, e.message, e.timestamp FROM events_fts f JOIN events e ON e.rowid = f.rowid WHERE events_fts MATCH ? ORDER BY f.rank LIMIT ?"),
  count: db.prepare("SELECT COUNT(*) as n FROM events"),
};

// --- Terminal ---
const term = {
  insert: db.prepare("INSERT INTO terminal_log (type, content) VALUES (?, ?)"),
  getAll: db.prepare("SELECT type, content, created_at FROM terminal_log ORDER BY id"),
  clear: db.prepare("DELETE FROM terminal_log"),
  setState: db.prepare("INSERT OR REPLACE INTO terminal_state (key, value) VALUES (?, ?)"),
  getState: db.prepare("SELECT value FROM terminal_state WHERE key = ?"),
};

// --- Roadmap ---
const rm = {
  all: db.prepare("SELECT * FROM roadmap ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'idea' THEN 2 WHEN 'done' THEN 3 END, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END, created DESC"),
  byStatus: db.prepare("SELECT * FROM roadmap WHERE status = ? ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END, created DESC"),
  insert: db.prepare("INSERT INTO roadmap (title, description, status, priority, category) VALUES (?, ?, ?, ?, ?)"),
  update: db.prepare("UPDATE roadmap SET title=?, description=?, status=?, priority=?, category=?, updated=datetime('now','localtime') WHERE id=?"),
  remove: db.prepare("DELETE FROM roadmap WHERE id = ?"),
  getById: db.prepare("SELECT * FROM roadmap WHERE id = ?"),
  count: db.prepare("SELECT COUNT(*) as n FROM roadmap"),
};

// --- Delegations ---
const dl = {
  insert: db.prepare("INSERT INTO delegations (assignee, assignee_email, context, subject, deadline, followup_days, next_followup, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  getById: db.prepare("SELECT * FROM delegations WHERE id = ?"),
  getOpen: db.prepare("SELECT * FROM delegations WHERE status IN ('open','in_progress') ORDER BY deadline ASC, created ASC"),
  getAll: db.prepare("SELECT * FROM delegations ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 END, created DESC"),
  getByAssignee: db.prepare("SELECT * FROM delegations WHERE assignee = ? AND status IN ('open','in_progress') ORDER BY created DESC"),
  getDueFollowups: db.prepare("SELECT * FROM delegations WHERE status IN ('open','in_progress') AND next_followup <= datetime('now','localtime')"),
  updateStatus: db.prepare("UPDATE delegations SET status=?, updated=datetime('now','localtime'), completed_at=CASE WHEN ?='done' THEN datetime('now','localtime') ELSE completed_at END WHERE id=?"),
  updateFollowup: db.prepare("UPDATE delegations SET last_followup=datetime('now','localtime'), next_followup=datetime('now','localtime', '+' || followup_days || ' days'), updated=datetime('now','localtime') WHERE id=?"),
  remove: db.prepare("DELETE FROM delegations WHERE id = ?"),
  insertTask: db.prepare("INSERT INTO delegation_tasks (delegation_id, task) VALUES (?, ?)"),
  getTasks: db.prepare("SELECT * FROM delegation_tasks WHERE delegation_id = ? ORDER BY id"),
  updateTaskStatus: db.prepare("UPDATE delegation_tasks SET status=?, completed_at=CASE WHEN ?='done' THEN datetime('now','localtime') ELSE completed_at END WHERE id=?"),
  getOpenTaskCount: db.prepare("SELECT COUNT(*) as n FROM delegation_tasks WHERE delegation_id = ? AND status != 'done'"),
  count: db.prepare("SELECT COUNT(*) as n FROM delegations WHERE status IN ('open','in_progress')"),
};

const delegations = {
  create(data) {
    const nextFollowup = data.followup_days
      ? new Date(Date.now() + data.followup_days * 86400000).toISOString().replace("T", " ").substring(0, 19)
      : null;
    const info = dl.insert.run(
      data.assignee, data.assignee_email, data.context || "work",
      data.subject, data.deadline || null, data.followup_days || 3,
      nextFollowup, data.chat_id || null
    );
    const delegation = dl.getById.get(info.lastInsertRowid);
    if (data.tasks && data.tasks.length) {
      for (const task of data.tasks) {
        dl.insertTask.run(delegation.id, task);
      }
    }
    return { ...delegation, tasks: dl.getTasks.all(delegation.id) };
  },

  getById(id) {
    const d = dl.getById.get(id);
    if (!d) return null;
    return { ...d, tasks: dl.getTasks.all(id) };
  },

  getOpen() {
    return dl.getOpen.all().map(d => ({ ...d, tasks: dl.getTasks.all(d.id) }));
  },

  getAll() {
    return dl.getAll.all().map(d => ({ ...d, tasks: dl.getTasks.all(d.id) }));
  },

  getByAssignee(name) {
    return dl.getByAssignee.all(name).map(d => ({ ...d, tasks: dl.getTasks.all(d.id) }));
  },

  getDueFollowups() {
    return dl.getDueFollowups.all().map(d => ({ ...d, tasks: dl.getTasks.all(d.id) }));
  },

  markTaskDone(taskId) {
    dl.updateTaskStatus.run("done", "done", taskId);
  },

  updateTaskStatus(taskId, status) {
    dl.updateTaskStatus.run(status, status, taskId);
  },

  updateStatus(id, status) {
    dl.updateStatus.run(status, status, id);
  },

  updateFollowup(id) {
    dl.updateFollowup.run(id);
  },

  checkAutoComplete(id) {
    const open = dl.getOpenTaskCount.get(id);
    if (open.n === 0) {
      dl.updateStatus.run("done", "done", id);
      return true;
    }
    return false;
  },

  remove(id) {
    dl.remove.run(id);
  },

  count() {
    return dl.count.get().n;
  },
};

// --- Tool Settings ---
const ts = {
  get: db.prepare("SELECT * FROM tool_settings WHERE filename = ?"),
  all: db.prepare("SELECT * FROM tool_settings ORDER BY filename"),
  upsert: db.prepare("INSERT OR REPLACE INTO tool_settings (filename, enabled, updated) VALUES (?, ?, datetime('now','localtime'))"),
  remove: db.prepare("DELETE FROM tool_settings WHERE filename = ?"),
};

// --- Workflows ---
const wf = {
  all: db.prepare("SELECT * FROM workflows ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'failed' THEN 2 WHEN 'completed' THEN 3 WHEN 'cancelled' THEN 4 END, updated DESC"),
  active: db.prepare("SELECT * FROM workflows WHERE status = 'running' ORDER BY updated DESC"),
  byStatus: db.prepare("SELECT * FROM workflows WHERE status = ? ORDER BY updated DESC"),
  getById: db.prepare("SELECT * FROM workflows WHERE id = ?"),
  insert: db.prepare("INSERT INTO workflows (id, name, status, chat_id, context, current_step) VALUES (?, ?, ?, ?, ?, ?)"),
  update: db.prepare("UPDATE workflows SET status=?, context=?, updated=datetime('now','localtime'), current_step=?, error=? WHERE id=?"),
  remove: db.prepare("DELETE FROM workflows WHERE id = ?"),
};

const wfs = {
  insert: db.prepare("INSERT INTO workflow_steps (workflow_id, step_num, action, status, scheduled, delay_minutes, condition) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  getByWf: db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_num"),
  getNext: db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? AND status = 'pending' ORDER BY step_num LIMIT 1"),
  getDue: db.prepare("SELECT ws.*, w.context, w.chat_id, w.name as workflow_name FROM workflow_steps ws JOIN workflows w ON w.id = ws.workflow_id WHERE w.status = 'running' AND ws.status = 'pending' AND (ws.scheduled IS NULL OR ws.scheduled <= datetime('now','localtime')) ORDER BY ws.step_num LIMIT 10"),
  update: db.prepare("UPDATE workflow_steps SET status=?, result=?, started_at=?, completed_at=? WHERE id=?"),
  skip: db.prepare("UPDATE workflow_steps SET status='skipped', completed_at=datetime('now','localtime') WHERE id=?"),
  setScheduled: db.prepare("UPDATE workflow_steps SET scheduled=? WHERE id=?"),
  count: db.prepare("SELECT COUNT(*) as n FROM workflow_steps WHERE workflow_id = ?"),
};

// ============================================================
// Messages API (aus chat-db.js übernommen)
// ============================================================

function extractPreview(role, content) {
  if (typeof content === "string") return content.substring(0, 500);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "tool_use") parts.push(`[Tool: ${block.name}]`);
    else if (block.type === "tool_result") {
      const txt = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      parts.push(`[Result] ${txt.substring(0, 200)}`);
    }
  }
  return parts.join(" ").substring(0, 500);
}

function detectMsgType(role, content) {
  if (typeof content === "string") return "text";
  if (!Array.isArray(content)) return "text";
  for (const block of content) {
    if (block.type === "tool_use") return "tool_use";
    if (block.type === "tool_result") return "tool_result";
  }
  return "text";
}

const messages = {
  save(chatId, role, content) {
    try {
      const contentJson = JSON.stringify(content);
      const preview = extractPreview(role, content);
      const msgType = detectMsgType(role, content);
      msg.insert.run(String(chatId), role, contentJson, preview, msgType);
    } catch (e) {
      console.error("[DB] messages.save Fehler:", e.message);
    }
  },

  getRecent(chatId, limit = 30) {
    try {
      const rows = msg.recent.all(String(chatId), limit);
      rows.reverse();
      return rows.map((row) => ({ role: row.role, content: JSON.parse(row.content) }));
    } catch (e) {
      console.error("[DB] messages.getRecent Fehler:", e.message);
      return [];
    }
  },

  search(query, chatId = null, limit = 10) {
    try {
      const ftsQuery = query.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
      const rows = msg.search.all(ftsQuery, limit);
      return rows.map((row) => {
        let context = [];
        try { context = msg.context.all(row.chat_id, row.id, row.id); } catch {}
        return {
          role: row.role, text: row.text_preview, date: row.created_at,
          context: context.map((c) => ({ role: c.role, text: c.text_preview, date: c.created_at })),
        };
      });
    } catch (e) {
      console.error("[DB] messages.search Fehler:", e.message);
      return [];
    }
  },

  clearChat(chatId) {
    try { msg.clearChat.run(String(chatId)); } catch (e) { console.error("[DB] messages.clearChat Fehler:", e.message); }
  },

  clearAll() {
    try {
      msg.clearAll.run();
      try { db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')"); } catch {}
    } catch (e) { console.error("[DB] messages.clearAll Fehler:", e.message); }
  },

  getStats() {
    try { return msg.stats.get(); } catch (e) { return { total: 0, chats: 0, oldest: null, newest: null }; }
  },
};

// ============================================================
// Memory API
// ============================================================

const memory = {
  getAll() {
    const rows = mem.all.all();
    const result = { facts: [], todos: [], notes: [] };
    for (const row of rows) {
      const entry = row.data_json ? JSON.parse(row.data_json) : { id: row.id, key: row.key, value: row.value, added: row.added };
      if (!result[row.category]) result[row.category] = [];
      result[row.category].push(entry);
    }
    return result;
  },

  getByCategory(category) {
    const rows = mem.byCategory.all(category);
    return rows.map((row) => row.data_json ? JSON.parse(row.data_json) : { id: row.id, key: row.key, value: row.value, added: row.added });
  },

  add(category, data) {
    data.id = Date.now();
    data.added = new Date().toISOString().split("T")[0];
    const key = data.key || data.task || data.topic || "";
    const value = data.value || data.task || data.content || "";
    mem.insert.run(data.id, category, key, value, data.added, JSON.stringify(data));
    return data;
  },

  remove(id) {
    const info = mem.remove.run(id);
    return info.changes > 0;
  },

  update(id, data) {
    // Bestehenden Eintrag laden
    const rows = db.prepare("SELECT * FROM memory WHERE id = ?").all(id);
    if (rows.length === 0) return null;
    const existing = rows[0].data_json ? JSON.parse(rows[0].data_json) : { id: rows[0].id, key: rows[0].key, value: rows[0].value, added: rows[0].added };
    Object.assign(existing, data);
    const key = existing.key || existing.task || existing.topic || "";
    const value = existing.value || existing.task || existing.content || "";
    mem.update.run(key, value, JSON.stringify(existing), id);
    return existing;
  },

  search(query, limit = 10) {
    try {
      const ftsQuery = query.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
      return mem.search.all(ftsQuery, limit);
    } catch { return []; }
  },
};

// ============================================================
// Reminders API
// ============================================================

const reminders = {
  getAll() { return rem.all.all().map(remRow); },
  getActive() { return rem.active.all().map(remRow); },
  getDue() { return rem.due.all().map(remRow); },

  create(data) {
    const id = data.id || Date.now() + Math.floor(Math.random() * 1000);
    const created = data.created || new Date().toISOString();
    rem.insert.run(id, data.text, data.due, data.chatId || data.chat_id || null, data.done ? 1 : 0, created, data.type || "text", data.interval_hours || data.intervalHours || null, data.failCount || data.fail_count || 0);
    return { id, text: data.text, due: data.due, chatId: data.chatId || data.chat_id || null, done: false, created, type: data.type || "text", interval_hours: data.interval_hours || data.intervalHours || null, failCount: 0 };
  },

  update(id, data) {
    const existing = rem.getById.get(id);
    if (!existing) return null;
    const r = remRow(existing);
    if (data.text !== undefined) r.text = data.text;
    if (data.due !== undefined) r.due = data.due;
    if (data.chatId !== undefined) r.chatId = data.chatId;
    if (data.done !== undefined) r.done = data.done;
    if (data.type !== undefined) r.type = data.type;
    if (data.interval_hours !== undefined) r.interval_hours = data.interval_hours;
    if (data.failCount !== undefined) r.failCount = data.failCount;
    rem.update.run(r.text, r.due, r.chatId, r.done ? 1 : 0, r.type, r.interval_hours, r.failCount, id);
    return r;
  },

  markDone(id) { rem.markDone.run(id); },

  advance(id) {
    const existing = rem.getById.get(id);
    if (!existing || !existing.interval_hours) return;
    const intervalMs = existing.interval_hours * 3600000;
    const now = Date.now();
    let next = new Date(existing.due).getTime() + intervalMs;
    while (next <= now) { next += intervalMs; }
    rem.advance.run(new Date(next).toISOString(), id);
  },

  incrementFailCount(id) {
    rem.incFail.run(id);
    const row = rem.getFail.get(id);
    return row ? row.fail_count : 0;
  },

  remove(id) {
    const info = rem.remove.run(id);
    return info.changes > 0;
  },

  getById(id) {
    const row = rem.getById.get(id);
    return row ? remRow(row) : null;
  },
};

// DB-Row → JS-Objekt (done: bool, camelCase)
function remRow(row) {
  return {
    id: row.id, text: row.text, due: row.due,
    chatId: row.chat_id, done: !!row.done, created: row.created,
    type: row.type || "text", interval_hours: row.interval_hours,
    failCount: row.fail_count || 0,
  };
}

// ============================================================
// Knowledge Base API
// ============================================================

const notes = {
  reindex() {
    try {
      const { getAllNotes, parseFrontmatter, NOTES_DIR } = require("./notes-utils");
      const allNotes = getAllNotes();

      const reindex = db.transaction(() => {
        db.exec("DELETE FROM kb_notes");
        for (const note of allNotes) {
          try {
            const content = fs.readFileSync(path.join(NOTES_DIR, note.filename), "utf-8");
            const { body } = parseFrontmatter(content);
            kb.upsert.run(note.filename, note.title, note.tags.join(", "), note.created, note.updated, note.size, body);
          } catch {}
        }
      });
      reindex();
      db.exec("INSERT INTO kb_notes_fts(kb_notes_fts) VALUES('rebuild')");
      console.log(`[DB] ${allNotes.length} Notizen indiziert`);
    } catch (e) {
      console.warn("[DB] Notizen-Index Fehler:", e.message);
    }
  },

  upsert(filename) {
    try {
      const { NOTES_DIR, parseFrontmatter } = require("./notes-utils");
      const filePath = path.join(NOTES_DIR, filename);
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, "utf-8");
      const stat = fs.statSync(filePath);
      const { meta, body } = parseFrontmatter(content);
      const title = meta.title || filename.replace(/\.md$/, "");
      const tags = Array.isArray(meta.tags) ? meta.tags.join(", ") : (meta.tags || "");
      kb.upsert.run(filename, title, tags, meta.created || "", meta.updated || "", stat.size, body);
    } catch (e) {
      console.warn("[DB] notes.upsert Fehler:", e.message);
    }
  },

  remove(filename) {
    try { kb.remove.run(filename); } catch {}
  },

  search(query, limit = 10) {
    try {
      const ftsQuery = query.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
      return kb.search.all(ftsQuery, limit);
    } catch (e) {
      console.warn("[DB] notes.search Fehler:", e.message);
      return [];
    }
  },

  getAll() {
    return kb.all.all().map((row) => ({
      filename: row.filename, title: row.title,
      tags: row.tags ? row.tags.split(", ").filter(Boolean) : [],
      created: row.created, updated: row.updated, size: row.size,
    }));
  },
};

// ============================================================
// Events API
// ============================================================

const events = {
  log(type, message) {
    try {
      const id = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      const timestamp = new Date().toISOString();
      evt.insert.run(id, type, String(message), timestamp);
    } catch {}
  },

  getRecent(limit = 200) {
    try { return evt.recent.all(limit); } catch { return []; }
  },

  since(fromDate, limit = 500) {
    try { return evt.since.all(fromDate, limit); } catch { return []; }
  },

  search(query, limit = 20) {
    try {
      const ftsQuery = query.trim().split(/\s+/).map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
      return evt.search.all(ftsQuery, limit);
    } catch { return []; }
  },

  cleanup() {
    try {
      const info = evt.cleanup.run();
      if (info.changes > 0) console.log(`[DB] ${info.changes} alte Events bereinigt`);
    } catch {}
  },

  count() {
    try { return evt.count.get().n; } catch { return 0; }
  },
};

// ============================================================
// Terminal API
// ============================================================

const terminal = {
  log(type, content) {
    try { term.insert.run(type, content); } catch {}
  },

  getLog() {
    try { return term.getAll.all(); } catch { return []; }
  },

  clear() {
    try { term.clear.run(); } catch {}
  },

  getCwd() {
    try {
      const row = term.getState.get("cwd");
      return row ? row.value : path.join(__dirname, "..");
    } catch { return path.join(__dirname, ".."); }
  },

  setCwd(cwd) {
    try { term.setState.run("cwd", cwd); } catch {}
  },

  getHistory() {
    try {
      const row = term.getState.get("cmd_history");
      return row ? JSON.parse(row.value) : [];
    } catch { return []; }
  },

  setHistory(history) {
    try { term.setState.run("cmd_history", JSON.stringify(history.slice(0, 100))); } catch {}
  },
};

// ============================================================
// Roadmap API
// ============================================================

const roadmap = {
  getAll(status) {
    if (status) return rm.byStatus.all(status);
    return rm.all.all();
  },

  create(data) {
    const info = rm.insert.run(
      data.title, data.description || "", data.status || "idea",
      data.priority || "normal", data.category || ""
    );
    return rm.getById.get(info.lastInsertRowid);
  },

  update(id, data) {
    const existing = rm.getById.get(id);
    if (!existing) return null;
    const r = { ...existing };
    if (data.title !== undefined) r.title = data.title;
    if (data.description !== undefined) r.description = data.description;
    if (data.status !== undefined) r.status = data.status;
    if (data.priority !== undefined) r.priority = data.priority;
    if (data.category !== undefined) r.category = data.category;
    rm.update.run(r.title, r.description, r.status, r.priority, r.category, id);
    return rm.getById.get(id);
  },

  remove(id) {
    const info = rm.remove.run(id);
    return info.changes > 0;
  },

  getById(id) {
    return rm.getById.get(id) || null;
  },
};

// ============================================================
// Tool Settings API
// ============================================================

const toolSettings = {
  isEnabled(filename) {
    const row = ts.get.get(filename);
    if (!row) return true;
    return !!row.enabled;
  },

  getAll() {
    return ts.all.all();
  },

  setEnabled(filename, enabled) {
    ts.upsert.run(filename, enabled ? 1 : 0);
  },

  toggle(filename) {
    const row = ts.get.get(filename);
    const newState = row ? !row.enabled : false;
    ts.upsert.run(filename, newState ? 1 : 0);
    return newState;
  },

  getVisibility(filename) {
    const row = ts.get.get(filename);
    return row?.visibility || "private";
  },

  setVisibility(filename, visibility) {
    const row = ts.get.get(filename);
    if (row) {
      db.prepare("UPDATE tool_settings SET visibility=?, updated=datetime('now','localtime') WHERE filename=?").run(visibility, filename);
    }
  },

  register(filename) {
    const row = ts.get.get(filename);
    if (!row) ts.upsert.run(filename, 1);
  },

  remove(filename) {
    ts.remove.run(filename);
  },
};

// ============================================================
// Workflows API (Agentic Loops)
// ============================================================

const workflows = {
  getAll(status) {
    if (status) return wf.byStatus.all(status);
    return wf.all.all();
  },

  getById(id) {
    const w = wf.getById.get(id);
    if (!w) return null;
    w.steps = wfs.getByWf.all(id);
    return w;
  },

  create(data) {
    const id = "wf-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const steps = data.steps || [];
    const context = JSON.stringify(data.context || {});

    const doCreate = db.transaction(() => {
      wf.insert.run(id, data.name, "running", data.chatId || null, context, 0);
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const status = "pending";
        const scheduled = s.scheduled || null;
        const delay = s.delay_minutes || null;
        const condition = s.condition ? JSON.stringify(s.condition) : null;
        wfs.insert.run(id, i + 1, s.action, status, scheduled, delay, condition);
      }
    });
    doCreate();

    // Ersten Schritt schedulen falls delay_minutes
    const firstStep = wfs.getNext.get(id);
    if (firstStep && firstStep.delay_minutes && !firstStep.scheduled) {
      const scheduled = new Date(Date.now() + firstStep.delay_minutes * 60000).toISOString();
      wfs.setScheduled.run(scheduled, firstStep.id);
    }

    return { id, name: data.name, steps: steps.length };
  },

  update(id, data) {
    const existing = wf.getById.get(id);
    if (!existing) return null;
    const status = data.status !== undefined ? data.status : existing.status;
    const context = data.context !== undefined ? (typeof data.context === "string" ? data.context : JSON.stringify(data.context)) : existing.context;
    const currentStep = data.current_step !== undefined ? data.current_step : existing.current_step;
    const error = data.error !== undefined ? data.error : existing.error;
    wf.update.run(status, context, currentStep, error, id);
    return wf.getById.get(id);
  },

  updateContext(id, updates) {
    const existing = wf.getById.get(id);
    if (!existing) return null;
    const ctx = JSON.parse(existing.context || "{}");
    Object.assign(ctx, updates);
    wf.update.run(existing.status, JSON.stringify(ctx), existing.current_step, existing.error, id);
    return ctx;
  },

  remove(id) {
    const doRemove = db.transaction(() => {
      db.prepare("DELETE FROM workflow_steps WHERE workflow_id = ?").run(id);
      wf.remove.run(id);
    });
    doRemove();
    return true;
  },

  getSteps(workflowId) {
    return wfs.getByWf.all(workflowId);
  },

  getDueSteps() {
    return wfs.getDue.all();
  },

  getNextStep(workflowId) {
    return wfs.getNext.get(workflowId) || null;
  },

  updateStep(stepId, data) {
    wfs.update.run(data.status || "pending", data.result || null, data.started_at || null, data.completed_at || null, stepId);
  },

  skipStep(stepId) {
    wfs.skip.run(stepId);
  },

  scheduleNextStep(workflowId) {
    const nextStep = wfs.getNext.get(workflowId);
    if (!nextStep) {
      // Alle Steps fertig → Workflow abschließen
      wf.update.run("completed", wf.getById.get(workflowId)?.context || "{}", wf.getById.get(workflowId)?.current_step || 0, null, workflowId);
      return null;
    }
    if (nextStep.delay_minutes && !nextStep.scheduled) {
      const scheduled = new Date(Date.now() + nextStep.delay_minutes * 60000).toISOString();
      wfs.setScheduled.run(scheduled, nextStep.id);
    }
    return nextStep;
  },
};

// ============================================================
// Migration: Bestehende Daten importieren
// ============================================================

function migrate() {
  // 1. Chat-History aus chat-history.db
  try {
    const msgCount = db.prepare("SELECT COUNT(*) as n FROM messages").get().n;
    if (msgCount === 0) {
      const oldDbPath = path.join(__dirname, "..", "chat-history.db");
      if (fs.existsSync(oldDbPath)) {
        db.exec(`ATTACH DATABASE '${oldDbPath}' AS old`);
        db.exec("INSERT INTO messages SELECT * FROM old.messages");
        db.exec("DETACH DATABASE old");
        db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
        const count = db.prepare("SELECT COUNT(*) as n FROM messages").get().n;
        console.log(`[DB] ${count} Chat-Nachrichten aus chat-history.db migriert`);
      }
    }
  } catch (e) {
    console.warn("[DB] Chat-Migration Warnung:", e.message);
  }

  // 2. Memory aus memory.json
  try {
    const memCount = db.prepare("SELECT COUNT(*) as n FROM memory").get().n;
    if (memCount === 0) {
      const memPath = path.join(__dirname, "..", "memory.json");
      if (fs.existsSync(memPath)) {
        const data = JSON.parse(fs.readFileSync(memPath, "utf-8"));
        const insert = db.prepare("INSERT INTO memory (id, category, key, value, added, data_json) VALUES (?, ?, ?, ?, ?, ?)");
        const doMigrate = db.transaction(() => {
          for (const cat of ["facts", "todos", "notes"]) {
            for (const entry of (data[cat] || [])) {
              if (typeof entry === "string") continue; // Kaputte Einträge überspringen
              const key = entry.key || entry.task || entry.topic || "";
              const value = entry.value || entry.task || entry.content || "";
              insert.run(entry.id || Date.now(), cat, key, value, entry.added || null, JSON.stringify(entry));
            }
          }
        });
        doMigrate();
        db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
        const count = db.prepare("SELECT COUNT(*) as n FROM memory").get().n;
        console.log(`[DB] ${count} Gedächtnis-Einträge aus memory.json migriert`);
      }
    }
  } catch (e) {
    console.warn("[DB] Memory-Migration Warnung:", e.message);
  }

  // 3. Reminders aus reminders.json
  try {
    const remCount = db.prepare("SELECT COUNT(*) as n FROM reminders").get().n;
    if (remCount === 0) {
      const remPath = path.join(__dirname, "..", "reminders.json");
      if (fs.existsSync(remPath)) {
        const data = JSON.parse(fs.readFileSync(remPath, "utf-8"));
        const insert = db.prepare("INSERT INTO reminders (id, text, due, chat_id, done, created, type, interval_hours, fail_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const doMigrate = db.transaction(() => {
          for (const r of data) {
            insert.run(r.id, r.text, r.due, r.chatId || null, r.done ? 1 : 0, r.created, r.type || "text", r.interval_hours || null, r.failCount || 0);
          }
        });
        doMigrate();
        db.exec("INSERT INTO reminders_fts(reminders_fts) VALUES('rebuild')");
        console.log(`[DB] ${data.length} Erinnerungen aus reminders.json migriert`);
      }
    }
  } catch (e) {
    console.warn("[DB] Reminders-Migration Warnung:", e.message);
  }

  // 4. Notizen indizieren (immer, Dateien sind Source of Truth)
  notes.reindex();

  // Roadmap: keine Seed-Daten — Nutzer erstellt eigene Einträge

  // 5. tool_settings: visibility Spalte hinzufügen (Migration)
  try {
    db.prepare("SELECT visibility FROM tool_settings LIMIT 1").get();
  } catch {
    try {
      db.exec("ALTER TABLE tool_settings ADD COLUMN visibility TEXT DEFAULT 'private'");
      console.log("[DB] tool_settings: visibility Spalte hinzugefügt");
    } catch {}
  }
}

migrate();

// Events-Cleanup bei Start + stündlich
events.cleanup();
setInterval(() => events.cleanup(), 3600000);

// ============================================================
// Export
// ============================================================

function close() {
  try { db.close(); } catch {}
}

module.exports = { db, messages, memory, reminders, notes, events, terminal, roadmap, delegations, workflows, toolSettings, close };
