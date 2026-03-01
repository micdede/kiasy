const chatDb = require("../lib/chat-db");

const definitions = [
  {
    name: "chat_search",
    description:
      "Volltextsuche im gesamten Chat-Verlauf mit Michael. Findet frühere Gespräche, Fragen und Antworten. Nutze dies wenn Michael fragt 'haben wir darüber gesprochen?' oder 'was habe ich letztens gesagt über...'",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Suchbegriff (ein oder mehrere Wörter)",
        },
        limit: {
          type: "number",
          description: "Maximale Anzahl Treffer (Standard: 10)",
        },
      },
      required: ["query"],
    },
  },
];

async function execute(name, input) {
  if (name === "chat_search") {
    const results = chatDb.searchMessages(input.query, null, input.limit || 10);

    if (results.length === 0) {
      return `Keine Treffer für "${input.query}" im Chat-Verlauf.`;
    }

    const lines = results.map((r, i) => {
      const ctx = r.context
        .map((c) => `  ${c.role === "user" ? "Michael" : "JARVIS"}: ${c.text.substring(0, 150)}`)
        .join("\n");
      return `${i + 1}. [${r.date}] ${r.role === "user" ? "Michael" : "JARVIS"}: ${r.text.substring(0, 200)}\n${ctx}`;
    });

    return `${results.length} Treffer für "${input.query}":\n\n${lines.join("\n\n")}`;
  }

  return `Unbekanntes Tool: ${name}`;
}

module.exports = { definitions, execute };
