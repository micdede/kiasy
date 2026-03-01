const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "chat-history.db");

// --- DB initialisieren ---

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
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
`);

// FTS5 Tabelle + Sync-Triggers
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text_preview, content='messages', content_rowid='id');`);
  // Triggers für automatischen FTS-Sync
  db.exec(`
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
  `);
} catch (e) {
  console.warn("FTS5 Setup-Warnung:", e.message);
}

// --- Prepared Statements ---

const stmtInsert = db.prepare(`
  INSERT INTO messages (chat_id, role, content, text_preview, msg_type)
  VALUES (?, ?, ?, ?, ?)
`);

const stmtRecent = db.prepare(`
  SELECT role, content FROM messages
  WHERE chat_id = ? ORDER BY id DESC LIMIT ?
`);

const stmtSearch = db.prepare(`
  SELECT m.id, m.chat_id, m.role, m.text_preview, m.created_at
  FROM messages_fts f
  JOIN messages m ON m.id = f.rowid
  WHERE messages_fts MATCH ?
  ORDER BY f.rank
  LIMIT ?
`);

const stmtContext = db.prepare(`
  SELECT role, text_preview, created_at FROM messages
  WHERE chat_id = ? AND id BETWEEN ? - 1 AND ? + 1
  ORDER BY id
`);

const stmtClearChat = db.prepare(`DELETE FROM messages WHERE chat_id = ?`);
const stmtClearAll = db.prepare(`DELETE FROM messages`);

const stmtStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(DISTINCT chat_id) as chats,
    MIN(created_at) as oldest,
    MAX(created_at) as newest
  FROM messages
`);

// --- text_preview Extraktion ---

function extractPreview(role, content) {
  if (typeof content === "string") return content.substring(0, 500);

  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(`[Tool: ${block.name}]`);
    } else if (block.type === "tool_result") {
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

// --- Öffentliche Funktionen ---

function saveMessage(chatId, role, content) {
  try {
    const contentJson = JSON.stringify(content);
    const preview = extractPreview(role, content);
    const msgType = detectMsgType(role, content);
    stmtInsert.run(String(chatId), role, contentJson, preview, msgType);
  } catch (e) {
    console.error("chat-db saveMessage Fehler:", e.message);
  }
}

function getRecentMessages(chatId, limit = 30) {
  try {
    const rows = stmtRecent.all(String(chatId), limit);
    // Reihenfolge umkehren (DB liefert neueste zuerst)
    rows.reverse();
    return rows.map((row) => ({
      role: row.role,
      content: JSON.parse(row.content),
    }));
  } catch (e) {
    console.error("chat-db getRecentMessages Fehler:", e.message);
    return [];
  }
}

function searchMessages(query, chatId = null, limit = 10) {
  try {
    // FTS5-Query: Wörter mit * für Prefix-Match
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .map((w) => `"${w.replace(/"/g, "")}"*`)
      .join(" ");

    const rows = stmtSearch.all(ftsQuery, limit);

    return rows.map((row) => {
      // Kontext laden (Nachricht davor/danach)
      let context = [];
      try {
        context = stmtContext.all(row.chat_id, row.id, row.id);
      } catch {}

      return {
        role: row.role,
        text: row.text_preview,
        date: row.created_at,
        context: context.map((c) => ({
          role: c.role,
          text: c.text_preview,
          date: c.created_at,
        })),
      };
    });
  } catch (e) {
    console.error("chat-db searchMessages Fehler:", e.message);
    return [];
  }
}

function clearChat(chatId) {
  try {
    stmtClearChat.run(String(chatId));
  } catch (e) {
    console.error("chat-db clearChat Fehler:", e.message);
  }
}

function clearAllChats() {
  try {
    stmtClearAll.run();
    // FTS-Index neu aufbauen
    try {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    } catch {}
  } catch (e) {
    console.error("chat-db clearAllChats Fehler:", e.message);
  }
}

function getStats() {
  try {
    return stmtStats.get();
  } catch (e) {
    console.error("chat-db getStats Fehler:", e.message);
    return { total: 0, chats: 0, oldest: null, newest: null };
  }
}

function close() {
  try {
    db.close();
  } catch {}
}

module.exports = { saveMessage, getRecentMessages, searchMessages, clearChat, clearAllChats, getStats, close };
