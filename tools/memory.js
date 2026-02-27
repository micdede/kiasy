const fs = require("fs");
const path = require("path");

const MEMORY_FILE = path.join(__dirname, "..", "memory.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch {
    return { facts: [], todos: [], notes: [] };
  }
}

function save(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf-8");
}

const definitions = [
  {
    name: "memory_read",
    description:
      "Liest das persistente Gedächtnis. Kategorien: facts (Fakten über Michael), " +
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
  const memory = load();

  if (name === "memory_read") {
    if (input.category) {
      return JSON.stringify(memory[input.category] || [], null, 2);
    }
    return JSON.stringify(memory, null, 2);
  }

  if (name === "memory_write") {
    const { category, action, data } = input;
    if (!memory[category]) memory[category] = [];

    switch (action) {
      case "add": {
        data.id = Date.now();
        data.added = new Date().toISOString().split("T")[0];
        memory[category].push(data);
        save(memory);
        return `Gespeichert in ${category}: ${JSON.stringify(data)}`;
      }

      case "remove": {
        const idx = memory[category].findIndex((e) => e.id === data.id);
        if (idx === -1) return `Eintrag mit ID ${data.id} nicht gefunden.`;
        const removed = memory[category].splice(idx, 1);
        save(memory);
        return `Entfernt: ${JSON.stringify(removed[0])}`;
      }

      case "update": {
        const entry = memory[category].find((e) => e.id === data.id);
        if (!entry) return `Eintrag mit ID ${data.id} nicht gefunden.`;
        Object.assign(entry, data);
        save(memory);
        return `Aktualisiert: ${JSON.stringify(entry)}`;
      }

      default:
        return `Unbekannte Aktion: ${action}`;
    }
  }

  return "Unbekanntes Memory-Tool.";
}

module.exports = { definitions, execute };
