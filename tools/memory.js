// const fs = require("fs");
// const path = require("path");
// const MEMORY_FILE = path.join(__dirname, "..", "memory.json");
// function load() { try { return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8")); } catch { return { facts: [], todos: [], notes: [] }; } }
// function save(memory) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf-8"); }

const db = require("../lib/db");

const definitions = [
  {
    name: "memory_read",
    description:
      "Liest das persistente Gedächtnis. Kategorien: facts (Fakten über den Nutzer), " +
      "todos (Aufgaben/To-Dos), notes (freie Notizen). Ohne Kategorie wird alles zurückgegeben.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["facts", "todos", "notes"],
          description: "Optionale Kategorie",
        },
      },
    },
  },
  {
    name: "memory_write",
    description:
      "Schreibt ins persistente Gedächtnis. Aktionen: add, remove (per id), update (per id).",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["facts", "todos", "notes"],
        },
        action: {
          type: "string",
          enum: ["add", "remove", "update"],
        },
        data: {
          type: "object",
          description:
            "Bei add: {key, value} für facts, {task} für todos, {topic, content} für notes. " +
            "Bei remove/update: {id} plus die zu ändernden Felder.",
        },
      },
      required: ["category", "action", "data"],
    },
  },
];

async function execute(name, input) {
  if (name === "memory_read") {
    if (input.category) {
      return JSON.stringify(db.memory.getByCategory(input.category), null, 2);
    }
    return JSON.stringify(db.memory.getAll(), null, 2);
  }

  if (name === "memory_write") {
    const { category, action, data } = input;

    switch (action) {
      case "add": {
        const entry = db.memory.add(category, data);
        return `Gespeichert in ${category}: ${JSON.stringify(entry)}`;
      }

      case "remove": {
        const removed = db.memory.remove(data.id);
        if (!removed) return `Eintrag mit ID ${data.id} nicht gefunden.`;
        return `Eintrag ${data.id} entfernt.`;
      }

      case "update": {
        const updated = db.memory.update(data.id, data);
        if (!updated) return `Eintrag mit ID ${data.id} nicht gefunden.`;
        return `Aktualisiert: ${JSON.stringify(updated)}`;
      }

      default:
        return `Unbekannte Aktion: ${action}`;
    }
  }

  return "Unbekanntes Memory-Tool.";
}

module.exports = { definitions, execute };
