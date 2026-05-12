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
import * as whisper from "./whisper.js";
import * as piper from "./piper.js";
import * as apns from "./apns.js";

const TOKEN   = process.env.TELEGRAM_TOKEN;
const ENABLED = process.env.TELEGRAM_ENABLED === "true";
// Reply-Mode: "auto" (text + voice nur wenn Input Voice war), "text", "voice", "both"
// Legacy: TELEGRAM_VOICE_REPLY=true ⇒ "both", false ⇒ "text"
const REPLY_MODE = (process.env.TELEGRAM_REPLY_MODE
  || (process.env.TELEGRAM_VOICE_REPLY === "true" ? "both" : "text")).toLowerCase();
function shouldSendText(inputWasVoice)  { return REPLY_MODE === "text"  || REPLY_MODE === "both" || REPLY_MODE === "auto"; }
function shouldSendVoice(inputWasVoice) {
  if (REPLY_MODE === "voice" || REPLY_MODE === "both") return true;
  if (REPLY_MODE === "auto") return inputWasVoice;
  return false;
}
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

  // Voice-Message → Whisper → Agent
  if (msg.voice) {
    try {
      bot.sendChatAction(chatId, "typing").catch(() => {});
      const fileLink = await bot.getFileLink(msg.voice.file_id);
      const audio = await fetch(fileLink).then(r => r.arrayBuffer());
      const trans = await whisper.transcribe(Buffer.from(audio), { language: "de", ext: "ogg" });
      const text = trans.text || "";
      console.log(`[telegram] ${fromId} voice → "${text.substring(0, 80)}"`);
      db.logEvent({ type: "telegram-voice-in", message: text.substring(0, 200), meta: { fromId, dur: msg.voice.duration } });

      const result = await agent.handle({ chatId, message: text });
      const skipVoiceV = result.tools_used?.includes("translate_and_speak");
      // Bei Voice-Input: Transkript immer mitschicken (zur Verifikation), Body je nach Modus
      if (shouldSendText(true)) {
        await safeReply(chatId, `🎙 \`${text}\`\n\n${result.text || "(leere Antwort)"}`);
      } else {
        await safeReply(chatId, `🎙 \`${text}\``);
      }
      if (shouldSendVoice(true) && !skipVoiceV) await sendVoice(chatId, result.text);
    } catch (err) {
      console.error("[telegram] voice handler:", err);
      await safeReply(chatId, `Voice-Fehler: ${err.message || err}`);
    }
    return;
  }

  if (!msg.text) {
    await safeReply(chatId, "Bilder kommen noch — bitte Text oder Voice.");
    return;
  }

  console.log(`[telegram] ${fromId}: ${msg.text.substring(0, 80)}`);
  db.logEvent({ type: "telegram-in", message: msg.text.substring(0, 200), meta: { fromId } });

  try {
    bot.sendChatAction(chatId, "typing").catch(() => {});
    const result = await agent.handle({ chatId, message: msg.text });
    const skipVoice = result.tools_used?.includes("translate_and_speak");
    if (shouldSendText(false)) await safeReply(chatId, result.text || "(leere Antwort)");
    if (shouldSendVoice(false) && !skipVoice) await sendVoice(chatId, result.text);
  } catch (err) {
    console.error("[telegram] handler error:", err);
    await safeReply(chatId, `Fehler: ${err.message || err}`);
  }
}

async function sendVoice(chatId, text) {
  if (!text) return;
  try {
    const wav = await piper.synthesize(text, { asWav: true });
    await bot.sendVoice(chatId, wav, {}, { filename: "reply.wav", contentType: "audio/wav" });
  } catch (err) {
    console.error("[telegram] sendVoice failed:", err.message);
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
  await safeReply(String(chatId), text);
  // iOS-Mirror: alle registrierten Geräte benachrichtigen (fire-and-forget)
  if (apns.isConfigured()) {
    const tokens = db.get().prepare("SELECT token FROM apns_tokens").all();
    if (tokens.length) {
      const preview = text.replace(/[*_`~\[\]#]/g, "").trim().substring(0, 140);
      for (const { token } of tokens) {
        apns.send(token, "JARVIS", preview, { "message-type": "chat" })
          .catch(() => {});
      }
    }
  }
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
