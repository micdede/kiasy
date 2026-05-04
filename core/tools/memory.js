// memory.js — persistentes Gedächtnis (facts/todos/notes in DB)

import * as db from "../lib/db.js";

export const definitions = [
  {
    name: "memory_read",
    description: "Liest gespeicherte Erinnerungen. Optional Kategorie filtern oder Volltext-Suche.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["facts", "todos", "notes"], description: "nur diese Kategorie" },
        search:   { type: "string", description: "Volltext-Suchbegriff (FTS5)" },
        limit:    { type: "integer", default: 50 }
      }
    }
  },
  {
    name: "memory_write",
    description: "Speichert eine neue Erinnerung. Kategorie 'facts' für Fakten, 'todos' für Aufgaben, 'notes' für freie Notizen.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["facts", "todos", "notes"] },
        value:    { type: "string", description: "Inhalt der Erinnerung" },
        key:      { type: "string", description: "optionales Stichwort" }
      },
      required: ["category", "value"]
    }
  },
  {
    name: "memory_delete",
    description: "Löscht eine Erinnerung anhand ihrer ID.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"]
    }
  }
];

export async function execute(name, input) {
  const conn = db.get();

  if (name === "memory_read") {
    const limit = input?.limit || 50;
    let rows;
    if (input?.search) {
      // FTS5 search
      rows = conn.prepare(`
        SELECT m.id, m.category, m.key, m.value, m.added
        FROM memory m
        JOIN memory_fts f ON m.id = f.rowid
        WHERE memory_fts MATCH ?
        ${input.category ? "AND m.category = ?" : ""}
        ORDER BY m.id DESC LIMIT ?
      `).all(...[input.search, input.category, limit].filter(x => x !== undefined));
    } else if (input?.category) {
      rows = conn.prepare(`
        SELECT id, category, key, value, added FROM memory
        WHERE category = ? ORDER BY id DESC LIMIT ?
      `).all(input.category, limit);
    } else {
      rows = conn.prepare(`
        SELECT id, category, key, value, added FROM memory
        ORDER BY id DESC LIMIT ?
      `).all(limit);
    }
    return { count: rows.length, items: rows };
  }

  if (name === "memory_write") {
    if (!input?.category || !input?.value) {
      throw new Error("category + value erforderlich");
    }
    const info = conn.prepare(`
      INSERT INTO memory(category, key, value, added) VALUES (?, ?, ?, date('now','localtime'))
    `).run(input.category, input.key || null, input.value);
    return { id: Number(info.lastInsertRowid), saved: true };
  }

  if (name === "memory_delete") {
    if (!input?.id) throw new Error("id erforderlich");
    const info = conn.prepare("DELETE FROM memory WHERE id = ?").run(input.id);
    return { deleted: info.changes > 0, id: input.id };
  }

  throw new Error(`unknown tool: ${name}`);
}
