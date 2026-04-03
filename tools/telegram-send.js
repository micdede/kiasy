// Telegram-Nachricht proaktiv senden — für Benachrichtigungen aus dem Monitor-Chat, Workflows etc.

let messageQueue = [];
function getQueue() { const q = [...messageQueue]; messageQueue = []; return q; }

const definitions = [
  {
    name: "send_telegram",
    description:
      "Sendet eine Nachricht per Telegram an den Nutzer. " +
      "Nutze dies wenn der Nutzer aus dem Monitor-Chat oder per Mail bittet, " +
      "eine Telegram-Nachricht zu senden, oder für proaktive Benachrichtigungen.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Die Nachricht die per Telegram gesendet werden soll" },
      },
      required: ["message"],
    },
  },
];

async function execute(name, input) {
  if (name === "send_telegram") {
    if (!input.message || !input.message.trim()) return "❌ Leere Nachricht.";
    messageQueue.push(input.message.trim());
    return `✅ Telegram-Nachricht wird gesendet: "${input.message.trim()}"`;
  }
  return "Unbekanntes Tool: " + name;
}

module.exports = { definitions, execute, getQueue };
