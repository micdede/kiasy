// chat-history.js — Volltext-Suche im Chat-Verlauf (FTS5)

import * as db from "../lib/db.js";

export const definitions = [{
  name: "chat_search",
  description: "Sucht im Chat-Verlauf via Volltext (FTS5). Nutze das, wenn der User auf eine frühere Unterhaltung verweist.",
  input_schema: {
    type: "object",
    properties: {
      query:  { type: "string", description: "Suchbegriff (FTS5-Syntax möglich, z.B. \"Kerio AND Mail\")" },
      chatId: { type: "string", description: "optional: nur in diesem Chat suchen" },
      limit:  { type: "integer", default: 10 }
    },
    required: ["query"]
  }
}];

export async function execute(name, input) {
  if (name !== "chat_search") throw new Error(`unknown tool: ${name}`);
  if (!input?.query) throw new Error("query erforderlich");

  const limit = input.limit || 10;
  const conn = db.get();

  let rows;
  if (input.chatId) {
    rows = conn.prepare(`
      SELECT m.id, m.chat_id, m.role, m.content, m.created_at
      FROM messages m
      JOIN messages_fts f ON m.id = f.rowid
      WHERE messages_fts MATCH ? AND m.chat_id = ?
      ORDER BY m.id DESC LIMIT ?
    `).all(input.query, input.chatId, limit);
  } else {
    rows = conn.prepare(`
      SELECT m.id, m.chat_id, m.role, m.content, m.created_at
      FROM messages m
      JOIN messages_fts f ON m.id = f.rowid
      WHERE messages_fts MATCH ?
      ORDER BY m.id DESC LIMIT ?
    `).all(input.query, limit);
  }

  // Snippet zur besseren Lesbarkeit
  const items = rows.map(r => ({
    ...r,
    content: r.content.length > 200 ? r.content.substring(0, 200) + "…" : r.content
  }));

  return { query: input.query, count: items.length, items };
}
