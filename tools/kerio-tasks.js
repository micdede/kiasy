const { withSession } = require("./kerio-api");

const definitions = [
  {
    name: "tasks_list",
    description:
      "Listet alle Aufgaben aus Kerio Connect auf. Zeigt Titel, Status und Fälligkeitsdatum.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "tasks_add",
    description: "Erstellt eine neue Aufgabe in Kerio Connect.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Titel der Aufgabe",
        },
        description: {
          type: "string",
          description: "Beschreibung der Aufgabe (optional)",
        },
        dueDate: {
          type: "string",
          description:
            "Fälligkeitsdatum als ISO-8601 (z.B. 2026-02-25T17:00:00+01:00, optional)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "tasks_complete",
    description: "Markiert eine Aufgabe als erledigt.",
    input_schema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Die ID der Aufgabe",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "tasks_delete",
    description: "Löscht eine Aufgabe aus Kerio Connect.",
    input_schema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Die ID der zu löschenden Aufgabe",
        },
      },
      required: ["taskId"],
    },
  },
];

async function execute(name, input) {
  try {
    return await withSession(async (rpc, folders) => {
      const folderId = folders.FTask;
      if (!folderId) return "❌ Kein Aufgaben-Ordner in Kerio gefunden.";

      switch (name) {
        case "tasks_list": {
          const res = await rpc("Tasks.get", {
            folderIds: [folderId],
            query: { start: 0, limit: 50 },
          });

          const tasks = res.list || [];
          if (tasks.length === 0) return "Keine Aufgaben vorhanden.";

          const lines = tasks.map((t) => {
            const title = t.summary || "(kein Titel)";
            const status =
              t.status === 2 || t.percentComplete === 100 ? "✅" : "⬜";
            const due = t.dueDate
              ? ` (fällig: ${new Date(t.dueDate).toLocaleDateString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin" })})`
              : "";
            return `${status} ${title}${due} [ID: ${t.id}]`;
          });

          return `📋 ${tasks.length} Aufgabe(n):\n${lines.join("\n")}`;
        }

        case "tasks_add": {
          const task = {
            folderId,
            summary: input.title,
          };
          if (input.description) {
            task.description = input.description;
          }
          if (input.dueDate) {
            task.dueDate = input.dueDate;
          }

          const res = await rpc("Tasks.create", { tasks: [task] });
          const created = res.result[0];
          return `✅ Aufgabe erstellt: "${input.title}" [ID: ${created.id}]`;
        }

        case "tasks_complete": {
          await rpc("Tasks.set", {
            taskIds: [input.taskId],
            tasks: [{ id: input.taskId, percentComplete: 100, status: 2 }],
          });
          return `✅ Aufgabe als erledigt markiert (ID: ${input.taskId})`;
        }

        case "tasks_delete": {
          await rpc("Tasks.remove", { taskIds: [input.taskId] });
          return `✅ Aufgabe gelöscht (ID: ${input.taskId})`;
        }

        default:
          return "Unbekannte Aufgaben-Operation.";
      }
    });
  } catch (error) {
    return `❌ Aufgaben-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
