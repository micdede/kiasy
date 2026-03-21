const fs = require("fs");
const path = require("path");
const {
  NOTES_DIR,
  ensureNotesDir,
  slugify,
  parseFrontmatter,
  buildFrontmatter,
  getAllNotes,
  validateNoteFilename,
} = require("../lib/notes-utils");
const { gitSync } = require("../lib/git-sync");
const db = require("../lib/db");

const definitions = [
  {
    name: "kb_list",
    description: "Listet alle Notizen in der Wissensbasis auf (Titel, Tags, Datum, Größe).",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "kb_search",
    description: "Volltextsuche in der Wissensbasis. Gibt max. 10 Treffer mit Kontext zurück.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Suchbegriff (durchsucht Titel, Tags und Inhalt)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "kb_read",
    description: "Liest den vollständigen Inhalt einer Notiz.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Dateiname der Notiz (z.B. server-migration.md)",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "kb_create",
    description: "Erstellt eine neue Notiz in der Wissensbasis mit Titel, Inhalt und optionalen Tags.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Titel der Notiz",
        },
        content: {
          type: "string",
          description: "Inhalt der Notiz (Markdown)",
        },
        tags: {
          type: "string",
          description: "Kommagetrennte Tags (optional, z.B. 'rezept, persönlich')",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "kb_update",
    description: "Aktualisiert eine bestehende Notiz. Mode: replace (Standard) ersetzt den Inhalt, append hängt an.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Dateiname der Notiz",
        },
        content: {
          type: "string",
          description: "Neuer Inhalt",
        },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description: "replace = Inhalt ersetzen, append = anhängen (Standard: replace)",
        },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "kb_delete",
    description: "Löscht eine Notiz aus der Wissensbasis.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Dateiname der Notiz",
        },
      },
      required: ["filename"],
    },
  },
];

async function execute(name, input) {
  ensureNotesDir();

  switch (name) {
    case "kb_list": {
      const notes = db.notes.getAll();
      if (notes.length === 0) return "Wissensbasis ist leer. Erstelle Notizen mit kb_create.";
      return notes
        .map(n => `- ${n.title} (${n.filename}) — ${n.tags.length ? "[" + n.tags.join(", ") + "] " : ""}${n.updated} — ${formatSize(n.size)}`)
        .join("\n");
    }

    case "kb_search": {
      const query = (input.query || "").trim();
      if (!query) return "Suchbegriff fehlt.";

      // FTS5-Suche statt File-Scanning
      const results = db.notes.search(query);
      if (results.length === 0) return `Keine Treffer für "${input.query}".`;

      return results
        .map(r => {
          const tags = r.tags ? r.tags.split(", ").filter(Boolean) : [];
          return `**${r.title}** (${r.filename})${tags.length ? " [" + tags.join(", ") + "]" : ""}\n> ${r.context || ""}`;
        })
        .join("\n\n");
    }

    case "kb_read": {
      if (!validateNoteFilename(input.filename)) return "Ungültiger Dateiname.";
      const filePath = path.join(NOTES_DIR, input.filename);
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return `Notiz "${input.filename}" nicht gefunden.`;
      }
    }

    case "kb_create": {
      if (!input.title || !input.content) return "Titel und Inhalt erforderlich.";

      const now = new Date().toISOString().split("T")[0];
      const tags = input.tags ? input.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
      const filename = slugify(input.title);

      const meta = { title: input.title, tags, created: now, updated: now };
      const fileContent = buildFrontmatter(meta) + input.content;

      fs.writeFileSync(path.join(NOTES_DIR, filename), fileContent, "utf-8");
      db.notes.upsert(filename);
      gitSync(`Neue Notiz: ${input.title}`);

      return `Notiz erstellt: ${filename}`;
    }

    case "kb_update": {
      if (!validateNoteFilename(input.filename)) return "Ungültiger Dateiname.";
      const filePath = path.join(NOTES_DIR, input.filename);

      if (!fs.existsSync(filePath)) return `Notiz "${input.filename}" nicht gefunden.`;

      const existing = fs.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(existing);
      const mode = input.mode || "replace";

      meta.updated = new Date().toISOString().split("T")[0];

      let newBody;
      if (mode === "append") {
        newBody = body + "\n" + input.content;
      } else {
        newBody = input.content;
      }

      fs.writeFileSync(filePath, buildFrontmatter(meta) + newBody, "utf-8");
      db.notes.upsert(input.filename);
      gitSync(`Notiz aktualisiert: ${meta.title || input.filename}`);

      return `Notiz aktualisiert: ${input.filename} (${mode})`;
    }

    case "kb_delete": {
      if (!validateNoteFilename(input.filename)) return "Ungültiger Dateiname.";
      const filePath = path.join(NOTES_DIR, input.filename);

      if (!fs.existsSync(filePath)) return `Notiz "${input.filename}" nicht gefunden.`;

      const { meta } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
      fs.unlinkSync(filePath);
      db.notes.remove(input.filename);
      gitSync(`Notiz gelöscht: ${meta.title || input.filename}`);

      return `Notiz gelöscht: ${input.filename}`;
    }

    default:
      return "Unbekanntes KB-Tool.";
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  return (bytes / 1024).toFixed(1) + " KB";
}

module.exports = { definitions, execute };
