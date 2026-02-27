const { withSession } = require("./kerio-api");

const definitions = [
  {
    name: "notes_list",
    description: "Listet alle Notizen aus Kerio Connect auf.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "notes_add",
    description: "Erstellt eine neue Notiz in Kerio Connect.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Inhalt der Notiz (Kerio-Notizen sind Haftnotizen mit reinem Text)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "notes_delete",
    description: "Löscht eine Notiz aus Kerio Connect anhand ihrer ID.",
    input_schema: {
      type: "object",
      properties: {
        noteId: {
          type: "string",
          description: "Die ID der zu löschenden Notiz",
        },
      },
      required: ["noteId"],
    },
  },
];

async function execute(name, input) {
  try {
    return await withSession(async (rpc, folders) => {
      const folderId = folders.FNote;
      if (!folderId) return "❌ Kein Notiz-Ordner in Kerio gefunden.";

      switch (name) {
        case "notes_list": {
          const res = await rpc("Notes.get", {
            folderIds: [folderId],
            query: { start: 0, limit: 50 },
          });

          const notes = res.list || [];
          if (notes.length === 0) return "Keine Notizen vorhanden.";

          const lines = notes.map((n) => {
            const text = (n.text || "").substring(0, 120) || "(leer)";
            return `• ${text} [ID: ${n.id}]`;
          });

          return `📝 ${notes.length} Notiz(en):\n${lines.join("\n")}`;
        }

        case "notes_add": {
          const res = await rpc("Notes.create", {
            notes: [{ folderId, text: input.text }],
          });
          const created = res.result[0];
          const preview = input.text.substring(0, 50);
          return `✅ Notiz erstellt: "${preview}" [ID: ${created.id}]`;
        }

        case "notes_delete": {
          await rpc("Notes.remove", { noteIds: [input.noteId] });
          return `✅ Notiz gelöscht (ID: ${input.noteId})`;
        }

        default:
          return "Unbekannte Notiz-Operation.";
      }
    });
  } catch (error) {
    return `❌ Notiz-Fehler: ${error.message}`;
  }
}

module.exports = { definitions, execute };
