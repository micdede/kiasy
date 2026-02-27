process.env.TZ = "Europe/Berlin";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const agent = require("./agent");
const voice = require("./voice");
require("./monitor").startMonitor(process.env.MONITOR_PORT || 3333);

// --- Konfiguration ---

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("FEHLER: Bitte setze TELEGRAM_TOKEN in der .env Datei.");
  console.error("Token von @BotFather in Telegram holen.");
  process.exit(1);
}

const ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USERS
  ? process.env.TELEGRAM_ALLOWED_USERS.split(",").map((n) => n.trim())
  : [];

// --- Verzeichnisse sicherstellen ---

fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "tools"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "temp"), { recursive: true });

const WHISPER_MODEL = process.env.WHISPER_MODEL || "tiny";
const TEMP_DIR = path.join(__dirname, "temp");

// --- Telegram Bot ---

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on("polling_error", (error) => {
  console.error("Polling-Fehler:", error.code || error.message);
});

console.log("Starte JARVIS (Telegram)...");

bot.getMe().then((me) => {
  console.log(`JARVIS ist bereit! (@${me.username})`);
  console.log(`Modell: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514"}`);
  if (ALLOWED_USERS.length > 0) {
    console.log(`Whitelist: ${ALLOWED_USERS.join(", ")}`);
  } else {
    console.log("Whitelist: deaktiviert (alle Nutzer erlaubt)");
  }
});

// Reminder-Scheduler: prüft jede Minute auf fällige Erinnerungen
setInterval(() => checkReminders(), 60000);
console.log("Reminder-Scheduler gestartet (60s Intervall)");

// Mail-Watcher starten
require("./mail-watcher").startMailWatcher(agent);

// --- Nachrichten-Handler ---

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);

  // Whitelist
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(userId)) {
    return;
  }

  let body = msg.text?.trim();
  let isVoice = false;

  // Sprachnachrichten transkribieren
  if (msg.voice || msg.audio) {
    isVoice = true;
    const transcription = await transcribeVoice(msg);
    if (transcription) {
      body = transcription;
    } else {
      await bot.sendMessage(
        chatId,
        "Sprachnachricht konnte nicht transkribiert werden.\n" +
          "Whisper installiert? `pip install openai-whisper`\n" +
          "ffmpeg installiert? `sudo apt install ffmpeg`",
        { parse_mode: "Markdown" }
      );
      return;
    }
  }

  if (!body) return;

  const ts = new Date().toLocaleTimeString("de-DE");
  console.log(`[${ts}] ${msg.from.username || userId}: ${body.substring(0, 80)}`);

  // Sonderbefehle
  if (body.toLowerCase() === "/reset" || body.toLowerCase() === "!reset") {
    agent.clearHistory(chatId);
    await bot.sendMessage(chatId, "Konversation zurückgesetzt.");
    return;
  }

  if (body.toLowerCase() === "/hilfe" || body.toLowerCase() === "!hilfe" || body === "/start") {
    await bot.sendMessage(
      chatId,
      "*JARVIS – Persönlicher Assistent*\n\n" +
        "Schreib einfach was du brauchst.\n\n" +
        "*Fähigkeiten:*\n" +
        "- Shell-Befehle ausführen\n" +
        "- Web-Recherche\n" +
        "- Dateien lesen/schreiben\n" +
        "- Gedächtnis (merkt sich Dinge)\n" +
        "- Selbst-Erweiterung\n\n" +
        "*Befehle:*\n" +
        "/reset – Konversation zurücksetzen\n" +
        "/hilfe – Diese Hilfe\n" +
        "/status – System-Status",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (body.toLowerCase() === "/status" || body.toLowerCase() === "!status") {
    const history = agent.getHistory(chatId);
    const toolCount = fs
      .readdirSync(path.join(__dirname, "tools"))
      .filter((f) => f.endsWith(".js")).length;
    const memSize = (() => {
      try {
        return JSON.stringify(
          JSON.parse(
            fs.readFileSync(path.join(__dirname, "memory.json"), "utf-8")
          )
        ).length;
      } catch {
        return 0;
      }
    })();

    await bot.sendMessage(
      chatId,
      `*JARVIS Status*\n\n` +
        `Modell: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514"}\n` +
        `Tools geladen: ${toolCount}\n` +
        `Nachrichten im Verlauf: ${history.length}\n` +
        `Aktive Chats: ${agent.conversations.size}\n` +
        `Gedächtnis: ${(memSize / 1024).toFixed(1)} KB`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Typing-Indikator
  await bot.sendChatAction(chatId, "typing");

  // Typing alle 4s wiederholen solange Agent arbeitet
  const typingInterval = setInterval(() => {
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  // Agent verarbeiten lassen
  try {
    const { text, images } = await agent.handleMessage(chatId, body);

    clearInterval(typingInterval);

    // Text senden
    if (text) {
      // Bei Sprachnachricht: per Voice antworten
      if (isVoice) {
        const voiceFile = await voice.textToSpeech(text);
        if (voiceFile) {
          try {
            await bot.sendVoice(chatId, voiceFile);
            console.log("  Sprachantwort gesendet");
          } catch (ttsErr) {
            console.error("  TTS-Sende-Fehler:", ttsErr.message);
            await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() =>
              bot.sendMessage(chatId, text)
            );
          } finally {
            try { fs.unlinkSync(voiceFile); } catch {}
          }
        } else {
          // TTS fehlgeschlagen – Text als Fallback
          await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() =>
            bot.sendMessage(chatId, text)
          );
        }
      } else if (text.length > 4000) {
        const chunks = splitMessage(text, 4000);
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(() =>
            bot.sendMessage(chatId, chunk)
          );
        }
      } else {
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(() =>
          bot.sendMessage(chatId, text)
        );
      }
    }

    // Bilder senden
    for (const img of images) {
      try {
        await bot.sendPhoto(chatId, img.path, {
          caption: img.caption || "",
        });
        console.log(`  Bild gesendet: ${img.path}`);
      } catch (imgErr) {
        console.error(`  Bild-Fehler (${img.path}):`, imgErr.message);
        await bot.sendMessage(
          chatId,
          `Bild konnte nicht gesendet werden: ${path.basename(img.path)}`
        );
      }
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error("Agent-Fehler:", error);
    await bot.sendMessage(chatId, "Fehler bei der Verarbeitung. Bitte versuche es erneut.");
  }
});

// --- Reminder-Scheduler ---

async function checkReminders() {
  try {
    const reminder = require("./tools/reminder");
    const due = reminder.getDueReminders();

    for (const r of due) {
      const chatId = r.chatId;
      if (!chatId) continue;

      try {
        await bot.sendMessage(chatId, `*Erinnerung:* ${r.text}`, {
          parse_mode: "Markdown",
        });
        reminder.markDone(r.id);
        console.log(`  Reminder gesendet: "${r.text}" -> ${chatId}`);
      } catch (err) {
        console.error(`  Reminder-Fehler für "${r.text}":`, err.message);
      }
    }
  } catch {
    // reminder.js noch nicht geladen – ignorieren
  }
}

// --- Sprach-Transkription ---

async function transcribeVoice(msg) {
  let audioFile;
  try {
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    if (!fileId) return null;

    const fileLink = await bot.getFileLink(fileId);
    const response = await fetch(fileLink);
    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = msg.voice ? ".ogg" : ".mp3";
    audioFile = path.join(TEMP_DIR, `voice_${Date.now()}${ext}`);
    fs.writeFileSync(audioFile, buffer);

    console.log(`  Transkribiere Sprachnachricht (${WHISPER_MODEL})...`);

    const text = voice.transcribe(audioFile);
    if (text) {
      console.log(`  Transkription: ${text.substring(0, 80)}`);
      return `[Sprachnachricht]: ${text}`;
    }
    return null;
  } catch (error) {
    console.error("Transkriptions-Fehler:", error.message);
    return null;
  } finally {
    if (audioFile) try { fs.unlinkSync(audioFile); } catch {}
  }
}

// --- Hilfsfunktionen ---

function splitMessage(text, maxLength) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1) splitAt = maxLength;

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// --- Graceful Shutdown ---

function shutdown(signal) {
  console.log(`\n${signal} – fahre herunter...`);
  bot.stopPolling();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
