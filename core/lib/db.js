// db.js — SQLite-Wrapper + Migrations-Runner
//
// Pfad der DB-Datei: /data/jarvis.db (Volume-Mount).
// Migrations: alle *.sql-Files in /db/migrations werden alphabetisch
// abgearbeitet, sofern noch nicht in Tabelle 'migrations' eingetragen.

import Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = process.env.DB_PATH || "/data/jarvis.db";
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || "/db/migrations";

let db;

export function init() {
  const dir = DB_PATH.substring(0, DB_PATH.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  runMigrations();
  console.log(`[db] opened ${DB_PATH}`);
  return db;
}

function runMigrations() {
  // Migrations-Tabelle anlegen falls sie fehlt (Bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  if (!existsSync(MIGRATIONS_DIR)) {
    console.warn(`[db] MIGRATIONS_DIR fehlt: ${MIGRATIONS_DIR}`);
    return;
  }

  const applied = new Set(
    db.prepare("SELECT name FROM migrations").all().map(r => r.name)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const name = file.replace(/\.sql$/, "");
    if (applied.has(name)) continue;
    console.log(`[db] applying migration ${name}…`);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      // 001_init enthält selbst INSERT — dann ist das ein NOOP
      db.prepare("INSERT OR IGNORE INTO migrations(name) VALUES (?)").run(name);
    });
    tx();
    console.log(`[db] ✓ ${name}`);
  }
}

export function get() {
  if (!db) throw new Error("db not initialized");
  return db;
}

export function close() {
  if (db) { db.close(); db = null; }
}

// ─── Messages-API ────────────────────────────────────────────

export function saveMessage({ chatId, role, content, msgType = "text", meta = null }) {
  const stmt = db.prepare(`
    INSERT INTO messages(chat_id, role, content, msg_type, meta)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    String(chatId),
    role,
    content,
    msgType,
    meta ? JSON.stringify(meta) : null
  );
  return Number(info.lastInsertRowid);
}

export function getRecentMessages(chatId, limit = 30) {
  const rows = db.prepare(`
    SELECT id, role, content, msg_type, meta, created_at
    FROM messages
    WHERE chat_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(String(chatId), limit);
  return rows.reverse().map(r => ({
    ...r,
    meta: r.meta ? safeParse(r.meta) : null
  }));
}

export function deleteMessagesByChatId(chatId) {
  const info = db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(String(chatId));
  return info.changes;
}

export function countMessages(chatId = null) {
  if (chatId) {
    return db.prepare("SELECT COUNT(*) c FROM messages WHERE chat_id = ?")
             .get(String(chatId)).c;
  }
  return db.prepare("SELECT COUNT(*) c FROM messages").get().c;
}

// ─── Events-API ──────────────────────────────────────────────

export function logEvent({ type, message, meta = null }) {
  db.prepare(`
    INSERT INTO events(type, message, meta) VALUES (?, ?, ?)
  `).run(type, message, meta ? JSON.stringify(meta) : null);
}

// ─── Helpers ─────────────────────────────────────────────────

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
