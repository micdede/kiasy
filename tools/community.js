// Community Chat Tool — Assistent kann im Community Chat lesen und schreiben
const axios = require("axios");

const API_BASE = "https://kiasy.de/api/kiasyApi.php";

function getConfig() {
  const enabled = process.env.COMMUNITY_ASSISTANT_ENABLED === "true";
  const name = process.env.COMMUNITY_ASSISTANT_NAME;
  const apiKey = process.env.COMMUNITY_ASSISTANT_APIKEY;
  if (!enabled || !name || !apiKey) {
    throw new Error("Community Chat für den Assistenten nicht aktiviert. Bitte in Einstellungen einrichten.");
  }
  return { name, apiKey };
}

const definitions = [
  {
    name: "community_read",
    description:
      "Liest die neuesten Nachrichten aus dem KIASY Community Chat. " +
      "Nutze dies wenn der Nutzer fragt was im Community Chat los ist oder ob es neue Nachrichten gibt.",
    input_schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Anzahl Nachrichten (Standard: 20, max 50)" },
      },
    },
  },
  {
    name: "community_send",
    description:
      "Sendet eine Nachricht im KIASY Community Chat als Assistent. " +
      "Nutze dies wenn der Nutzer dich bittet etwas im Community Chat zu schreiben.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Die Nachricht die gesendet werden soll" },
      },
      required: ["message"],
    },
  },
  {
    name: "community_online",
    description:
      "Zeigt wer gerade im Community Chat online ist.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

async function execute(name, input) {
  try {
    const cfg = getConfig();

    switch (name) {
      case "community_read": {
        const count = Math.min(input.count || 20, 50);
        const res = await axios.get(API_BASE, {
          params: { action: "messages", since: 0, limit: count },
          headers: { "X-API-Key": cfg.apiKey },
          timeout: 10000,
        });

        const messages = res.data.messages || [];
        if (messages.length === 0) return "Keine Nachrichten im Community Chat.";

        // Nur die letzten N anzeigen
        const recent = messages.slice(-count);
        const lines = recent.map(m => {
          const icon = m.type === "assistant" ? "🤖" : "👤";
          const time = m.created_at ? m.created_at.substring(11, 16) : "";
          const displayName = m.type === "assistant" ? m.username + " (" + (m.bot_name || "Bot") + ")" : m.username;
          return `${icon} [${time}] ${displayName}: ${m.message}`;
        });

        const online = (res.data.online || []).map(u => {
          const icon = u.type === "assistant" ? "🤖" : "👤";
          return `${icon} ${u.username}`;
        });

        let result = `💬 Community Chat (${recent.length} Nachrichten):\n\n${lines.join("\n")}`;
        if (online.length > 0) {
          result += `\n\n🟢 Online: ${online.join(", ")}`;
        }
        return result;
      }

      case "community_send": {
        if (!input.message || !input.message.trim()) return "❌ Leere Nachricht.";

        await axios.post(API_BASE + "?action=send", {
          message: input.message.trim(),
        }, {
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": cfg.apiKey,
          },
          timeout: 10000,
        });

        return `✅ Nachricht im Community Chat gesendet: "${input.message.trim()}"`;
      }

      case "community_online": {
        const res = await axios.get(API_BASE, {
          params: { action: "messages", since: 999999999, limit: 1 },
          headers: { "X-API-Key": cfg.apiKey },
          timeout: 10000,
        });

        const online = res.data.online || [];
        if (online.length === 0) return "Niemand ist gerade im Community Chat online.";

        const lines = online.map(u => {
          const icon = u.type === "assistant" ? "🤖" : "👤";
          return `${icon} ${u.username}${u.bot_name ? " (" + u.bot_name + ")" : ""}`;
        });

        return `🟢 ${online.length} online im Community Chat:\n${lines.join("\n")}`;
      }

      default:
        return "Unbekannte Community-Operation.";
    }
  } catch (error) {
    if (error.message.includes("nicht aktiviert")) return `❌ ${error.message}`;
    return `❌ Community-Fehler: ${error.response?.data?.error || error.message}`;
  }
}

module.exports = { definitions, execute };
