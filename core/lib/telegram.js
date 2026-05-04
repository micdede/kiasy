// telegram.js — Telegram-Bot via Long-Polling
//
// Default DEAKTIVIERT (TELEGRAM_ENABLED!=true), damit V2 nicht mit
// dem laufenden V1-Bot um den gleichen Token kollidiert (409 Conflict).
//
// Whitelist via TELEGRAM_ALLOWED_USERS (comma-separated User-IDs).
// chat_id Format: roher Telegram-chat.id (kompatibel mit V1-DB).

import TelegramBot from "node-telegram-bot-api";
import * as agent from "./agent.js";
import * as db from "./db.js";

const TOKEN   = process.env.TELEGRAM_TOKEN;
const ENABLED = process.env.TELEGRAM_ENABLED === "true";
const ALLOWED = (process.env.TELEGRAM_ALLOWED_USERS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

let bot = null;
let me  = null;

export function start() {
  if (!ENABLED) {
    console.log("[telegram] disabled (TELEGRAM_ENABLED != true)");
    return;
  }
  if (!TOKEN) {
    console.warn("[telegram] TELEGRAM_TOKEN fehlt — überspringe");
    return;
  }

  bot = new TelegramBot(TOKEN, { polling: true });

  bot.on("polling_error", err => {
    console.error("[telegram] polling_error:", err.code || err.message);
  });

  bot.on("message", handleMessage);

  bot.getMe()
    .then(info => {
      me = info;
      console.log(`[telegram] polling as @${info.username} (whitelist: ${ALLOWED.length ? ALLOWED.join(",") : "any"})`);
    })
    .catch(err => console.error("[telegram] getMe failed:", err.message));
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const fromId = String(msg.from?.id || "");

  // Whitelist
  if (ALLOWED.length && !ALLOWED.includes(fromId)) {
    console.log(`[telegram] ignored from ${fromId}`);
    return;
  }

  // Etappe 2: nur Text. Voice/Bilder folgen.
  if (!msg.text) {
    await safeReply(chatId, "Voice/Bilder kommen noch — bitte Text.");
    return;
  }

  console.log(`[telegram] ${fromId}: ${msg.text.substring(0, 80)}`);
  db.logEvent({ type: "telegram-in", message: msg.text.substring(0, 200), meta: { fromId } });

  try {
    bot.sendChatAction(chatId, "typing").catch(() => {});
    const result = await agent.handle({ chatId, message: msg.text });
    await safeReply(chatId, result.text || "(leere Antwort)");
  } catch (err) {
    console.error("[telegram] handler error:", err);
    await safeReply(chatId, `Fehler: ${err.message || err}`);
  }
}

async function safeReply(chatId, text) {
  if (!bot) return;
  // Telegram-Limit: 4096 Zeichen pro Message
  const chunks = chunkText(text, 4000);
  for (const c of chunks) {
    try {
      await bot.sendMessage(chatId, c);
    } catch (err) {
      console.error("[telegram] sendMessage failed:", err.message);
    }
  }
}

function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;  // kein guter Break → hart schneiden
    out.push(rest.substring(0, cut));
    rest = rest.substring(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export async function send(chatId, text) {
  if (!bot) throw new Error("telegram not started (TELEGRAM_ENABLED=true setzen)");
  return safeReply(String(chatId), text);
}

export function stop() {
  if (!bot) return;
  bot.stopPolling().catch(() => {});
  bot = null;
  me = null;
  console.log("[telegram] stopped");
}

export function getInfo() {
  return { enabled: ENABLED, started: !!bot, me: me ? { id: me.id, username: me.username } : null, whitelist: ALLOWED };
}
