require("dotenv").config();
process.env.TZ = process.env.TZ || "Europe/Berlin";
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

// Reminder- & Workflow-Scheduler: prüft jede Minute auf fällige Erinnerungen und Workflow-Schritte
setInterval(() => { checkReminders(); checkWorkflows(); }, 60000);
console.log("Reminder- & Workflow-Scheduler gestartet (60s Intervall)");

// Mail-Watcher starten (nur wenn Kerio konfiguriert)
if (process.env.KERIO_HOST && process.env.KERIO_USER && process.env.KERIO_PASSWORD) {
  require("./mail-watcher").startMailWatcher(agent);
} else {
  console.log("Mail-Watcher übersprungen (Kerio nicht konfiguriert)");
}

// --- Nachrichten-Handler ---

const LAST_CHAT_FILE = path.join(__dirname, ".last-telegram-chat");
let lastKnownChatId = null;
try { lastKnownChatId = fs.readFileSync(LAST_CHAT_FILE, "utf-8").trim() || null; } catch {}

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  lastKnownChatId = chatId;
  try { fs.writeFileSync(LAST_CHAT_FILE, chatId); } catch {}

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

  if (body.toLowerCase() === "/hilfe" || body.toLowerCase() === "!hilfe") {
    const botName = process.env.BOT_NAME || "JARVIS";
    await bot.sendMessage(
      chatId,
      `*${botName} – Persönlicher Assistent*\n\n` +
        "Schreib einfach was du brauchst.\n\n" +
        "*Fähigkeiten:*\n" +
        "- Shell-Befehle ausführen\n" +
        "- Web-Recherche\n" +
        "- Dateien lesen/schreiben\n" +
        "- Gedächtnis (merkt sich Dinge)\n" +
        "- Wissensbasis (Notizen)\n" +
        "- Erinnerungen & Workflows\n" +
        "- Selbst-Erweiterung\n\n" +
        "*Befehle:*\n" +
        "/reset – Konversation zurücksetzen\n" +
        "/hilfe – Diese Hilfe\n" +
        "/status – System-Status",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // --- Onboarding: Erster Start ---
  const ONBOARDED_FILE = path.join(__dirname, ".onboarded");
  if (body === "/start" && !fs.existsSync(ONBOARDED_FILE)) {
    fs.writeFileSync(ONBOARDED_FILE, new Date().toISOString());
    const botName = process.env.BOT_NAME || "JARVIS";
    const ownerName = process.env.OWNER_NAME || "du";
    const onboardingPrompt =
      `Der Nutzer hat gerade /start gedrückt und dies ist das ERSTE Gespräch. ` +
      `Stelle dich als ${botName} vor — kurz und freundlich. ` +
      `Erkläre in 2-3 Sätzen was du kannst. ` +
      `Dann stelle ${ownerName} ein paar Fragen um ihn/sie besser kennenzulernen:\n` +
      `1. Was machst du beruflich / was sind deine Interessen?\n` +
      `2. Wofür wirst du mich hauptsächlich nutzen?\n` +
      `3. Gibt es etwas Wichtiges das ich über dich wissen sollte?\n` +
      `Speichere alle Antworten mit memory_write (Kategorie: facts). ` +
      `Stelle die Fragen EINZELN — nicht alle auf einmal. Starte mit der Vorstellung und der ersten Frage.`;
    body = onboardingPrompt;
  } else if (body === "/start") {
    const botName = process.env.BOT_NAME || "JARVIS";
    await bot.sendMessage(chatId, `${botName} ist bereit! Schreib /hilfe für eine Übersicht.`);
    return;
  }

  if (body.toLowerCase() === "/status" || body.toLowerCase() === "!status") {
    const history = agent.getHistory(chatId);
    const toolCount = fs
      .readdirSync(path.join(__dirname, "tools"))
      .filter((f) => f.endsWith(".js")).length;
    // DB-Statistiken
    let dbInfo = "";
    let memCount = 0;
    try {
      const stats = agent.db.messages.getStats();
      const memData = agent.db.memory.getAll();
      memCount = (memData.facts || []).length + (memData.todos || []).length + (memData.notes || []).length;
      dbInfo = `\nChat-DB: ${stats.total} Nachrichten, ${stats.chats} Chats` +
        (stats.oldest ? `\nÄlteste Nachricht: ${stats.oldest}` : "");
    } catch {}

    await bot.sendMessage(
      chatId,
      `*JARVIS Status*\n\n` +
        `Modell: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514"}\n` +
        `Tools geladen: ${toolCount}\n` +
        `Nachrichten im Verlauf: ${history.length}\n` +
        `Aktive Chats: ${agent.conversations.size}\n` +
        `Gedächtnis: ${memCount} Einträge` +
        dbInfo,
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

const processingReminders = new Set();

async function checkReminders() {
  try {
    const reminder = require("./tools/reminder");
    const due = reminder.getDueReminders();

    const fallbackChatId = (process.env.TELEGRAM_ALLOWED_USERS || "").split(",").map(s => s.trim()).find(Boolean)
      || lastKnownChatId || null;

    for (const r of due) {
      const chatId = r.chatId || fallbackChatId;
      if (!chatId) continue;
      if (processingReminders.has(r.id)) continue;

      processingReminders.add(r.id);
      try {
        if (r.type === "task") {
          // Aufgabe: Prompt an Agent senden
          console.log(`  Task-Reminder startet: "${r.text}" -> ${chatId}`);
          await bot.sendChatAction(chatId, "typing");

          try {
            const { text } = await agent.handleMessage(chatId, r.text);
            const header = "*Automatische Aufgabe:*";
            const msg = text ? `${header}\n${text}` : `${header}\nAufgabe ausgeführt (keine Ausgabe).`;

            if (msg.length > 4000) {
              const chunks = splitMessage(msg, 4000);
              for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(() =>
                  bot.sendMessage(chatId, chunk)
                );
              }
            } else {
              await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(() =>
                bot.sendMessage(chatId, msg)
              );
            }

            // Erfolg: recurring vorsetzen oder einmalig erledigen
            if (r.interval_hours) {
              reminder.advanceReminder(r.id);
              console.log(`  Task-Reminder wiederholt: "${r.text}" -> nächster Termin`);
            } else {
              reminder.markDone(r.id);
            }
          } catch (taskErr) {
            console.error(`  Task-Reminder Fehler für "${r.text}":`, taskErr.message);
            const count = reminder.incrementFailCount(r.id);
            if (count >= 3) {
              await bot.sendMessage(
                chatId,
                `*Aufgabe pausiert:* "${r.text}" — 3x fehlgeschlagen. Nutze reminder\\_list um den Status zu sehen.`,
                { parse_mode: "Markdown" }
              ).catch(() => {});
            } else {
              await bot.sendMessage(
                chatId,
                `*Aufgabe fehlgeschlagen (${count}/3):* "${r.text}" — ${taskErr.message}`,
                { parse_mode: "Markdown" }
              ).catch(() => {});
            }
          }
        } else {
          // Text-Erinnerung (bestehend)
          const isRecurring = !!r.interval_hours;
          const header = isRecurring ? "*Erinnerung (wiederkehrend):*" : "*Erinnerung:*";

          await bot.sendMessage(chatId, `${header} ${r.text}`, {
            parse_mode: "Markdown",
          });

          if (isRecurring) {
            reminder.advanceReminder(r.id);
            console.log(`  Reminder wiederholt: "${r.text}" -> nächster Termin`);
          } else {
            reminder.markDone(r.id);
          }
          console.log(`  Reminder gesendet: "${r.text}" -> ${chatId}`);
        }
      } catch (err) {
        console.error(`  Reminder-Fehler für "${r.text}":`, err.message);
      } finally {
        processingReminders.delete(r.id);
      }
    }
  } catch {
    // reminder.js noch nicht geladen – ignorieren
  }
}

// --- Workflow-Scheduler ---

const processingSteps = new Set();
const db = require("./lib/db");

async function checkWorkflows() {
  try {
    const dueSteps = db.workflows.getDueSteps();
    const fallbackChatId = (process.env.TELEGRAM_ALLOWED_USERS || "").split(",").map(s => s.trim()).find(Boolean)
      || lastKnownChatId || null;

    for (const step of dueSteps) {
      if (processingSteps.has(step.id)) continue;
      processingSteps.add(step.id);

      try {
        const context = JSON.parse(step.context || "{}");
        const chatId = step.chat_id || fallbackChatId;

        // Bedingung prüfen
        if (step.condition) {
          try {
            const cond = JSON.parse(step.condition);
            const fieldValue = context[cond.field];
            const skip =
              (cond.equals !== undefined && String(fieldValue) !== String(cond.equals)) ||
              (cond.not_equals !== undefined && String(fieldValue) === String(cond.not_equals));
            if (skip) {
              db.workflows.skipStep(step.id);
              console.log(`  Workflow "${step.workflow_name}" Schritt ${step.step_num} übersprungen (Bedingung nicht erfüllt)`);
              db.workflows.scheduleNextStep(step.workflow_id);
              continue;
            }
          } catch (e) {
            console.warn("  Workflow-Bedingung ungültig:", e.message);
          }
        }

        // Step ausführen
        db.workflows.updateStep(step.id, { status: "running", started_at: new Date().toISOString() });
        console.log(`  Workflow "${step.workflow_name}" Schritt ${step.step_num}: "${step.action.substring(0, 60)}"`);

        if (chatId) await bot.sendChatAction(chatId, "typing").catch(() => {});

        const { text } = await agent.handleMessage(chatId || "workflow", step.action, {
          workflowId: step.workflow_id,
          workflowName: step.workflow_name,
          workflowContext: context,
          stepNum: step.step_num,
        });

        // Step abschließen
        db.workflows.updateStep(step.id, {
          status: "completed",
          result: JSON.stringify({ text: (text || "").substring(0, 5000) }),
          completed_at: new Date().toISOString(),
        });

        // Workflow-Fortschritt aktualisieren
        db.workflows.update(step.workflow_id, { current_step: step.step_num });

        // Ergebnis an User senden
        if (chatId) {
          const msg = `*Workflow "${step.workflow_name}" — Schritt ${step.step_num}:*\n${text || "(keine Ausgabe)"}`;
          if (msg.length > 4000) {
            const chunks = splitMessage(msg, 4000);
            for (const chunk of chunks) {
              await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" }).catch(() =>
                bot.sendMessage(chatId, chunk)
              );
            }
          } else {
            await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" }).catch(() =>
              bot.sendMessage(chatId, msg)
            );
          }
        }

        // Nächsten Step schedulen
        db.workflows.scheduleNextStep(step.workflow_id);

      } catch (err) {
        console.error(`  Workflow-Schritt Fehler:`, err.message);
        db.workflows.updateStep(step.id, {
          status: "failed",
          result: JSON.stringify({ error: err.message }),
          completed_at: new Date().toISOString(),
        });
        db.workflows.update(step.workflow_id, { status: "failed", error: err.message });

        const chatId = step.chat_id || fallbackChatId;
        if (chatId) {
          await bot.sendMessage(chatId,
            `*Workflow "${step.workflow_name}" fehlgeschlagen:*\nSchritt ${step.step_num}: ${err.message}`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      } finally {
        processingSteps.delete(step.id);
      }
    }
  } catch {}
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
