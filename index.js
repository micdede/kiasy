process.env.TZ = "Europe/Berlin";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const agent = require("./agent");

// --- Konfiguration ---

const ALLOWED_NUMBERS = process.env.ALLOWED_NUMBERS
  ? process.env.ALLOWED_NUMBERS.split(",").map((n) => n.trim())
  : [];

const llmProvider = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
if (
  llmProvider === "anthropic" &&
  (!process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_API_KEY === "sk-ant-DEIN-API-KEY-HIER")
) {
  console.error("FEHLER: Bitte setze ANTHROPIC_API_KEY in der .env Datei.");
  process.exit(1);
}

// --- Verzeichnisse sicherstellen ---

fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "tools"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "temp"), { recursive: true });

const WHISPER_MODEL = process.env.WHISPER_MODEL || "tiny";

// --- WhatsApp Client ---

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("QR-Code scannen:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("JARVIS ist bereit!");
  console.log(`Modell: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514"}`);
  if (ALLOWED_NUMBERS.length > 0) {
    console.log(`Whitelist: ${ALLOWED_NUMBERS.join(", ")}`);
  } else {
    console.log("Whitelist: deaktiviert");
  }

  // Reminder-Scheduler: prüft jede Minute auf fällige Erinnerungen
  setInterval(() => checkReminders(), 60000);
  console.log("Reminder-Scheduler gestartet (60s Intervall)");
});

client.on("auth_failure", (msg) => {
  console.error("Auth-Fehler:", msg);
});

client.on("disconnected", (reason) => {
  console.log("Getrennt:", reason);
  setTimeout(() => client.initialize(), 5000);
});

// --- Nachrichten-Handler ---

client.on("message", async (message) => {
  // Nur Direktnachrichten
  if (message.from.endsWith("@g.us")) return;
  if (message.from === "status@broadcast") return;

  // Whitelist
  const senderId = message.from.split("@")[0];
  if (ALLOWED_NUMBERS.length > 0 && !ALLOWED_NUMBERS.includes(senderId)) {
    return;
  }

  let body = message.body?.trim();

  // Sprachnachrichten transkribieren
  if (message.hasMedia && (message.type === "ptt" || message.type === "audio")) {
    const transcription = await transcribeVoice(message);
    if (transcription) {
      body = transcription;
    } else {
      await message.reply(
        "❌ Sprachnachricht konnte nicht transkribiert werden.\n" +
          "Whisper installiert? → `pip install openai-whisper`\n" +
          "ffmpeg installiert? → `sudo apt install ffmpeg`"
      );
      return;
    }
  }

  if (!body) return;

  const ts = new Date().toLocaleTimeString("de-DE");
  console.log(`[${ts}] ${message.from}: ${body.substring(0, 80)}`);

  // Sonderbefehle
  if (body.toLowerCase() === "!reset") {
    agent.clearHistory(message.from);
    await message.reply("🔄 Konversation zurückgesetzt.");
    return;
  }

  if (body.toLowerCase() === "!hilfe") {
    await message.reply(
      "*JARVIS – Persönlicher Assistent*\n\n" +
        "Schreib einfach was du brauchst.\n\n" +
        "*Fähigkeiten:*\n" +
        "• 🖥️ Shell-Befehle ausführen\n" +
        "• 🔍 Web-Recherche\n" +
        "• 📁 Dateien lesen/schreiben\n" +
        "• 🧠 Gedächtnis (merkt sich Dinge)\n" +
        "• 🔧 Selbst-Erweiterung\n\n" +
        "*Befehle:*\n" +
        "• !reset – Konversation zurücksetzen\n" +
        "• !hilfe – Diese Hilfe\n" +
        "• !status – System-Status"
    );
    return;
  }

  if (body.toLowerCase() === "!status") {
    const history = agent.getHistory(message.from);
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

    await message.reply(
      `*JARVIS Status*\n\n` +
        `Modell: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514"}\n` +
        `Tools geladen: ${toolCount}\n` +
        `Nachrichten im Verlauf: ${history.length}\n` +
        `Aktive Chats: ${agent.conversations.size}\n` +
        `Gedächtnis: ${(memSize / 1024).toFixed(1)} KB`
    );
    return;
  }

  // Typing-Indikator
  const chat = await message.getChat();
  await chat.sendStateTyping();

  // Agent verarbeiten lassen
  try {
    const { text, images } = await agent.handleMessage(message.from, body);

    // Text senden
    if (text) {
      if (text.length > 4000) {
        const chunks = splitMessage(text, 4000);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } else {
        await message.reply(text);
      }
    }

    // Bilder senden
    for (const img of images) {
      try {
        const media = MessageMedia.fromFilePath(img.path);
        await message.reply(media, undefined, { caption: img.caption || "" });
        console.log(`  Bild gesendet: ${img.path}`);
      } catch (imgErr) {
        console.error(`  Bild-Fehler (${img.path}):`, imgErr.message);
        await message.reply(`❌ Bild konnte nicht gesendet werden: ${path.basename(img.path)}`);
      }
    }
  } catch (error) {
    console.error("Agent-Fehler:", error);
    await message.reply("❌ Fehler bei der Verarbeitung. Bitte versuche es erneut.");
  }

  await chat.clearState();
});

// --- Reminder-Scheduler ---

async function checkReminders() {
  try {
    const reminder = require("./tools/reminder");
    const due = reminder.getDueReminders();

    for (const r of due) {
      const chatId = r.chatId || ALLOWED_NUMBERS[0] + "@lid";
      if (!chatId) continue;

      try {
        await client.sendMessage(chatId, `⏰ *Erinnerung:* ${r.text}`);
        reminder.markDone(r.id);
        console.log(`  Reminder gesendet: "${r.text}" → ${chatId}`);
      } catch (err) {
        // Chat-ID könnte @c.us statt @lid sein – zweiten Versuch mit @c.us
        try {
          const altChatId = ALLOWED_NUMBERS[0] + "@c.us";
          await client.sendMessage(altChatId, `⏰ *Erinnerung:* ${r.text}`);
          reminder.markDone(r.id);
          console.log(`  Reminder gesendet: "${r.text}" → ${altChatId}`);
        } catch {
          console.error(`  Reminder-Fehler für "${r.text}":`, err.message);
        }
      }
    }
  } catch {
    // reminder.js noch nicht geladen – ignorieren
  }
}

// --- Sprach-Transkription ---

const TEMP_DIR = path.join(__dirname, "temp");

async function transcribeVoice(message) {
  let audioFile;
  try {
    const media = await message.downloadMedia();
    if (!media) return null;

    audioFile = path.join(TEMP_DIR, `voice_${Date.now()}.ogg`);
    fs.writeFileSync(audioFile, Buffer.from(media.data, "base64"));

    console.log(`  Transkribiere Sprachnachricht (${WHISPER_MODEL})...`);

    const whisperBin = path.join(__dirname, "venv", "bin", "whisper");
    execSync(
      `"${whisperBin}" "${audioFile}" --model ${WHISPER_MODEL} --language de --output_format txt --output_dir "${TEMP_DIR}"`,
      { timeout: 120000, encoding: "utf-8" }
    );

    const txtFile = audioFile.replace(/\.[^.]+$/, ".txt");
    if (fs.existsSync(txtFile)) {
      const text = fs.readFileSync(txtFile, "utf-8").trim();
      try { fs.unlinkSync(txtFile); } catch {}
      console.log(`  Transkription: ${text.substring(0, 80)}`);
      return text ? `[Sprachnachricht]: ${text}` : null;
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

// --- Chrome Singleton Cleanup ---

const SESSION_DIR = path.join(__dirname, ".wwebjs_auth", "session");

function cleanSingletonLocks() {
  try {
    for (const file of fs.readdirSync(SESSION_DIR)) {
      if (file.startsWith("Singleton")) {
        fs.unlinkSync(path.join(SESSION_DIR, file));
      }
    }
  } catch {}

  try {
    for (const entry of fs.readdirSync("/tmp")) {
      if (entry.startsWith("org.chromium.Chromium.")) {
        fs.rmSync(path.join("/tmp", entry), { recursive: true, force: true });
      }
    }
  } catch {}

  console.log("Chrome-Locks bereinigt.");
}

cleanSingletonLocks();

// --- Graceful Shutdown ---

async function shutdown(signal) {
  console.log(`\n${signal} – fahre herunter...`);
  try {
    await client.destroy();
  } catch {}
  cleanSingletonLocks();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// --- Start ---

console.log("Starte JARVIS...");
client.initialize();
