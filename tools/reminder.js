const fs = require("fs");
const path = require("path");

const REMINDERS_FILE = path.join(__dirname, "..", "reminders.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(reminders) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8");
}

const definitions = [
  {
    name: "reminder_set",
    description:
      "Setzt eine Erinnerung für einen bestimmten Zeitpunkt. " +
      "Michael wird dann proaktiv benachrichtigt.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Erinnerungstext",
        },
        due: {
          type: "string",
          description:
            "Fälligkeitszeitpunkt als ISO-8601 String (z.B. 2026-02-19T09:00:00). Zeitzone: Europe/Berlin.",
        },
        chatId: {
          type: "string",
          description: "WhatsApp Chat-ID des Empfängers (wird automatisch gesetzt)",
        },
      },
      required: ["text", "due"],
    },
  },
  {
    name: "reminder_list",
    description: "Zeigt alle aktiven (nicht erledigten) Erinnerungen.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "reminder_delete",
    description: "Löscht eine Erinnerung per ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "ID der Erinnerung" },
      },
      required: ["id"],
    },
  },
];

async function execute(name, input) {
  const reminders = load();

  switch (name) {
    case "reminder_set": {
      const reminder = {
        id: Date.now(),
        text: input.text,
        due: input.due,
        chatId: input.chatId || null,
        done: false,
        created: new Date().toISOString(),
      };
      reminders.push(reminder);
      save(reminders);

      const dueDate = new Date(input.due);
      const formatted = dueDate.toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `Erinnerung gesetzt: "${input.text}" am ${formatted}`;
    }

    case "reminder_list": {
      const active = reminders.filter((r) => !r.done);
      if (active.length === 0) return "Keine aktiven Erinnerungen.";

      return active
        .map((r) => {
          const due = new Date(r.due).toLocaleString("de-DE", {
            timeZone: "Europe/Berlin",
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          return `ID ${r.id}: "${r.text}" – ${due}`;
        })
        .join("\n");
    }

    case "reminder_delete": {
      const idx = reminders.findIndex((r) => r.id === input.id);
      if (idx === -1) return `Erinnerung ${input.id} nicht gefunden.`;
      const removed = reminders.splice(idx, 1);
      save(reminders);
      return `Gelöscht: "${removed[0].text}"`;
    }

    default:
      return "Unbekannte Reminder-Operation.";
  }
}

// Wird vom Scheduler in index.js aufgerufen
function getDueReminders() {
  const reminders = load();
  const now = new Date();
  const due = reminders.filter((r) => !r.done && new Date(r.due) <= now);
  return due;
}

function markDone(id) {
  const reminders = load();
  const reminder = reminders.find((r) => r.id === id);
  if (reminder) {
    reminder.done = true;
    save(reminders);
  }
}

module.exports = { definitions, execute, getDueReminders, markDone };
