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
          description: "Erinnerungstext oder Aufgaben-Prompt (bei type=task)",
        },
        due: {
          type: "string",
          description:
            "Fälligkeitszeitpunkt als ISO-8601 String (z.B. 2026-02-19T09:00:00). Zeitzone: Europe/Berlin.",
        },
        type: {
          type: "string",
          enum: ["text", "task"],
          description:
            "Art der Erinnerung: 'text' (Standard) = Nachricht senden, 'task' = Text als Prompt an Agent senden und Ergebnis zurückmelden",
        },
        interval_hours: {
          type: "number",
          description:
            "Wiederholungsintervall in Stunden (z.B. 24 = täglich, 168 = wöchentlich). Ohne Angabe = einmalig.",
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
        type: input.type || "text",
        interval_hours: input.interval_hours || null,
        failCount: 0,
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

      let confirm = `Erinnerung gesetzt: "${input.text}" am ${formatted}`;
      if (reminder.type === "task") {
        confirm += " (wird als Aufgabe ausgeführt)";
      }
      if (reminder.interval_hours) {
        const h = reminder.interval_hours;
        if (h % 24 === 0 && h >= 24) {
          const days = h / 24;
          confirm += days === 1 ? " — wiederholt täglich" : ` — wiederholt alle ${days} Tage`;
        } else {
          confirm += h === 1 ? " — wiederholt stündlich" : ` — wiederholt alle ${h}h`;
        }
      }
      return confirm;
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
          let line = `ID ${r.id}: "${r.text}" – ${due}`;
          if (r.type === "task") line += " [Aufgabe]";
          if (r.interval_hours) {
            const h = r.interval_hours;
            if (h % 24 === 0 && h >= 24) {
              line += ` (alle ${h / 24}d)`;
            } else {
              line += ` (alle ${h}h)`;
            }
          }
          if (r.failCount >= 3) line += " ⚠️ pausiert";
          return line;
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

// Wird vom Scheduler in telegram.js aufgerufen
function getDueReminders() {
  const reminders = load();
  const now = new Date();
  return reminders.filter(
    (r) => !r.done && new Date(r.due) <= now && (r.failCount || 0) < 3
  );
}

function markDone(id) {
  const reminders = load();
  const reminder = reminders.find((r) => r.id === id);
  if (reminder) {
    reminder.done = true;
    save(reminders);
  }
}

// Setzt due auf den nächsten zukünftigen Termin (überspringt vergangene Intervalle)
function advanceReminder(id) {
  const reminders = load();
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder || !reminder.interval_hours) return;

  const intervalMs = reminder.interval_hours * 3600000;
  const now = Date.now();
  let next = new Date(reminder.due).getTime() + intervalMs;

  // Überspringe vergangene Termine (z.B. nach Offline-Zeit)
  while (next <= now) {
    next += intervalMs;
  }

  reminder.due = new Date(next).toISOString();
  reminder.failCount = 0;
  save(reminders);
}

// Erhöht den Fehlerzähler bei Task-Fehlschlägen
function incrementFailCount(id) {
  const reminders = load();
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder) return 0;

  reminder.failCount = (reminder.failCount || 0) + 1;
  save(reminders);
  return reminder.failCount;
}

module.exports = { definitions, execute, getDueReminders, markDone, advanceReminder, incrementFailCount };
