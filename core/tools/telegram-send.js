// telegram-send.js — Proaktive Telegram-Nachricht senden
// Nutzt den TELEGRAM_TOKEN direkt via Bot-API (unabhängig vom Polling-State)

const TOKEN  = process.env.TELEGRAM_TOKEN;
const CHATID = process.env.TELEGRAM_OWNER_CHAT_ID;

export const definitions = [{
  name: "send_telegram",
  description: "Schickt eine Telegram-Nachricht an den Owner-Chat. Nutze für proaktive Benachrichtigungen oder wenn der User explizit sagt 'schick mir eine Nachricht'.",
  input_schema: {
    type: "object",
    properties: {
      message: { type: "string" },
      chatId:  { type: "string", description: "optional, default: TELEGRAM_OWNER_CHAT_ID" }
    },
    required: ["message"]
  }
}];

export async function execute(name, input) {
  if (name !== "send_telegram") throw new Error(`unknown: ${name}`);
  if (!TOKEN) throw new Error("TELEGRAM_TOKEN nicht gesetzt");
  if (!input?.message?.trim()) throw new Error("message leer");

  const chat_id = input.chatId || CHATID;
  if (!chat_id) throw new Error("Kein chatId und kein TELEGRAM_OWNER_CHAT_ID");

  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text: input.message }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return { sent: data.ok, message_id: data.result?.message_id };
}
