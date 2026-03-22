const fs = require("fs");
const path = require("path");
const { createProvider } = require("./providers");
// const chatDb = require("./lib/chat-db"); // DEPRECATED: Replaced by lib/db.js
const db = require("./lib/db");

// --- Konfiguration ---

const MAX_TOKENS = Math.max(parseInt(process.env.MAX_TOKENS, 10) || 4096, 2048);
const MAX_AGENT_TURNS = 15;
const MAX_HISTORY = 30;
const TOOLS_DIR = path.join(__dirname, "tools");

// --- Provider erstellen ---

function buildProviderConfig() {
  const provider = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();

  switch (provider) {
    case "ollama":
      return {
        provider,
        baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
        model: process.env.OLLAMA_MODEL || "llama3.1",
        maxTokens: MAX_TOKENS,
      };
    case "groq":
      return {
        provider,
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_MODEL || "llama-3.1-70b-versatile",
        maxTokens: MAX_TOKENS,
      };
    case "openai":
      return {
        provider,
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || "gpt-4o",
        maxTokens: MAX_TOKENS,
      };
    case "anthropic":
    default:
      return {
        provider: "anthropic",
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
        maxTokens: MAX_TOKENS,
      };
  }
}

const providerConfig = buildProviderConfig();
const provider = createProvider(providerConfig);

console.log(`LLM-Provider: ${provider.name}`);

// --- System-Prompt ---

function getSystemPrompt() {
  const now = new Date();
  const datum = now.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const uhrzeit = now.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });

  // Home Assistant Geräteliste laden
  let haDevices = '';
  try {
    haDevices = fs.readFileSync(path.join(__dirname, 'ha-devices-compact.md'), 'utf-8');
  } catch {}

  // Wissensbasis-Index laden
  let notesIndex = '';
  try {
    const { getAllNotes } = require('./lib/notes-utils');
    const notes = getAllNotes();
    if (notes.length > 0) {
      notesIndex = '\n## Wissensbasis (' + notes.length + ' Notizen)\n' +
        notes.map(n => '- ' + n.title + (n.tags.length ? ' [' + n.tags.join(', ') + ']' : '') + ' (' + n.filename + ')').join('\n');
    }
  } catch {}


  return `Du bist JARVIS, der persönliche KI-Assistent von Michael.

## Aktuell
- Datum: ${datum}
- Uhrzeit: ${uhrzeit} (Europe/Berlin)

## Über Michael
- PHP-Entwickler, arbeitet mit ragMultitool
- Administriert Kerio Connect Server
- Technisch versiert, bevorzugt direkte Kommunikation

## Deine Persönlichkeit
- Hilfsbereit, proaktiv und direkt – kein Geschwätz
- Du sprichst Michael mit "du" an
- Antworte IMMER auf Deutsch, niemals auf Chinesisch oder anderen Sprachen. Technische Fachbegriffe bleiben englisch
- Nutze WhatsApp-Formatierung: *fett*, _kursiv_, \`\`\`code\`\`\`
- Halte Antworten kurz und auf den Punkt

## Kerio Connect Integration
- Du hast Zugriff auf JARVIS' eigenes Kerio-Konto (Mail, Kalender, Kontakte, Notizen, Aufgaben)
- Kalender (CalDAV): calendar_list (Termine auflisten), calendar_add (Termin erstellen), calendar_delete (Termin per UID löschen)
- Mail (IMAP/SMTP): mail_list (Mails auflisten), mail_read (Mail per UID lesen), mail_send (Mail senden)
- Kontakte (CardDAV): contacts_search (Kontakt suchen), contacts_add (Kontakt anlegen)
- Notizen (JSON-RPC): notes_list (Notizen auflisten), notes_add (Notiz erstellen), notes_delete (Notiz löschen)
- Aufgaben (JSON-RPC): tasks_list (Aufgaben auflisten), tasks_add (Aufgabe erstellen), tasks_complete (Aufgabe erledigen), tasks_delete (Aufgabe löschen)
- Bei Kalender-Anfragen: Nutze immer Europe/Berlin als Zeitzone
- Bei Mails: Kein Löschen möglich (Sicherheit). Zum Lesen erst mail_list, dann mail_read mit der UID

## Home Assistant Integration
- Du steuerst Michaels Smart Home über Home Assistant
- ha_get_states: Entities abfragen — ohne Parameter für Übersicht, mit entity_id für Details, mit domain für alle einer Art (light, switch, sensor, climate...)
- ha_call_service: Services aufrufen — Licht dimmen (brightness), Heizung stellen (temperature), Szenen aktivieren, Automationen starten
- ha_toggle: Schnelles Ein/Ausschalten einer Entity
- ha_history: Verlauf einer Entity (z.B. Temperaturverlauf der letzten 24h)
- Bei "Mach Licht an/aus": ha_toggle oder ha_call_service mit light Domain — nutze die Geräteliste unten um die richtige entity_id zu finden
- Bei Temperatur-Fragen: ha_get_states mit dem passenden sensor aus der Geräteliste
- Bei "Heizung auf X Grad": ha_call_service mit domain=climate, service=set_temperature, data={temperature: X}
- WICHTIG: Nutze die Geräteliste unten, um entity_ids direkt zu verwenden statt erst ha_get_states aufzurufen!

${haDevices}

## Wissensbasis (Knowledge Base)
- kb_list: Alle Notizen auflisten (Titel, Tags, Datum)
- kb_search: Volltextsuche in Notizen — nutze dies wenn Michael nach gespeichertem Wissen fragt
- kb_read: Vollständigen Inhalt einer Notiz lesen
- kb_create: Neue Notiz erstellen (Titel + Inhalt + optionale Tags)
- kb_update: Notiz aktualisieren (replace oder append)
- kb_delete: Notiz löschen
- WICHTIG: Wenn Michael dich bittet etwas zu merken/speichern, nutze kb_create. Bei Fragen nach gespeichertem Wissen nutze kb_search.
${notesIndex}

## Chat-Verlauf
- chat_search: Volltextsuche in früheren Gesprächen — nutze dies wenn Michael fragt was er gesagt hat, ob ihr über etwas gesprochen habt, oder nach früheren Diskussionen sucht
- Der gesamte Chat-Verlauf wird persistent gespeichert und überlebt Neustarts

## Verhalten
- Einfache Fragen direkt beantworten, ohne Tools
- Bei Bedarf Tools nutzen – erkläre kurz was du tust
- Wichtige Infos über Michael im Gedächtnis (memory_write) speichern
- Todos und Aufgaben merken
- WICHTIG: Wenn Michael an etwas erinnert werden will, MUSST du das Tool reminder_set aufrufen mit ISO-Zeitstempel (z.B. 2026-02-22T09:00:00). Nur textlich bestätigen reicht NICHT!
- Erinnerungen haben zwei Typen: type="text" (Standard, sendet nur Text) und type="task" (Text wird als Prompt an den Agent geschickt, der Tools nutzt und das Ergebnis zurücksendet)
- Für wiederkehrende Erinnerungen: interval_hours setzen (24 = täglich, 168 = wöchentlich, 1 = stündlich)
- Beispiel: "Prüfe täglich um 9 Uhr alle Batteriesensoren unter 25%" → reminder_set mit type="task", due="2026-03-02T09:00:00", interval_hours=24, text="Prüfe alle HA-Batteriesensoren (domain=sensor, Attribut battery) unter 25% und liste die betroffenen Geräte auf"
- Für Dateien senden: send_image nutzen (Bilder)
- Sprachnachrichten werden automatisch transkribiert – du erhältst den Text mit [Sprachnachricht]: Präfix
- Wenn dir eine Fähigkeit fehlt: npm-Paket per shell installieren und neues Tool-Modul unter /home/mcde/whatsapp-claude/tools/ anlegen
- Maximal 15 Tool-Aufrufe pro Anfrage – plane effizient, fasse Schritte zusammen

## Workflows (Mehrstufige Aufgaben)
- workflow_create: Mehrstufigen Workflow definieren — Schritte werden nacheinander vom Scheduler ausgeführt
  - Jeder Schritt ist ein eigenständiger Agent-Prompt mit vollem Tool-Zugriff
  - Schritte können Bedingungen haben: condition={"field":"x","equals":"y"} prüft den Kontext
  - Schritte können Verzögerungen haben: delay_minutes=5 wartet 5 Minuten nach dem vorherigen Schritt
  - Kontext (key-value State) fließt durch alle Schritte — nutze workflow_update_context um Ergebnisse zu speichern
- workflow_status: Status eines Workflows oder aller aktiven abfragen
- workflow_update_context: Kontext innerhalb eines Schrittes aktualisieren (Ergebnisse für nächsten Schritt)
- workflow_cancel: Laufenden Workflow abbrechen
- workflow_continue: Bei langen Aufgaben mit vielen Tool-Calls "brauche mehr Schritte" signalisieren — wird automatisch fortgesetzt
- Beispiel: "Prüfe ob Server erreichbar → wenn nicht, warte 5 Min → prüfe nochmal → sende Alarm"
  → workflow_create mit name="Server-Check", steps=[{action:"Ping Server..."}, {action:"Prüfe nochmal...", delay_minutes:5, condition:{"field":"server_down","equals":"true"}}]

## Selbst-Erweiterung
Wenn du ein neues Tool brauchst:
1. Installiere ggf. ein npm-Paket via shell (cd /home/mcde/whatsapp-claude && npm install paket)
2. Erstelle eine neue .js Datei in /home/mcde/whatsapp-claude/tools/ mit file_write
3. Das Modul muss exportieren: { definitions: [...], execute: async (name, input) => ... }
4. Das Tool wird beim nächsten Nachrichteneingang automatisch geladen

## Sicherheit
- Nur innerhalb /home/mcde/ operieren
- Keine Systemdateien, keine Netzwerkkonfiguration ändern
- Bei destruktiven Operationen (Löschen, Überschreiben) vorher nachfragen`;
}

// --- Dynamisches Tool-Loading ---

function loadTools() {
  const tools = new Map();
  const definitions = [];

  if (!fs.existsSync(TOOLS_DIR)) return { tools, definitions };

  for (const file of fs.readdirSync(TOOLS_DIR)) {
    if (!file.endsWith(".js")) continue;
    try {
      const fullPath = path.join(TOOLS_DIR, file);
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      if (mod.definitions && mod.execute) {
        for (const def of mod.definitions) {
          // Fix: "parameters" → "input_schema" (häufiger Fehler bei Selbst-Erweiterung)
          if (def.parameters && !def.input_schema) {
            def.input_schema = def.parameters;
            delete def.parameters;
          }
          if (!def.input_schema) {
            console.warn(`  Tool "${def.name}" übersprungen: input_schema fehlt`);
            continue;
          }
          definitions.push(def);
          tools.set(def.name, mod.execute);
        }
      }
    } catch (error) {
      console.error(`Tool-Ladefehler (${file}):`, error.message);
    }
  }

  return { tools, definitions };
}

// --- Konversations-Verwaltung ---

const conversations = new Map();

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    // Aus DB laden falls vorhanden
    try {
      const saved = db.messages.getRecent(chatId, MAX_HISTORY);
      if (saved.length > 0) {
        trimHistory(saved);
        conversations.set(chatId, saved);
      } else {
        conversations.set(chatId, []);
      }
    } catch {
      conversations.set(chatId, []);
    }
  }
  return conversations.get(chatId);
}

function clearHistory(chatId) {
  conversations.delete(chatId);
  try { db.messages.clearChat(chatId); } catch {}
}

function trimHistory(history) {
  while (history.length > MAX_HISTORY) {
    if (
      history.length >= 2 &&
      history[0].role === "assistant" &&
      Array.isArray(history[0].content) &&
      history[0].content.some((b) => b.type === "tool_use")
    ) {
      history.splice(0, 2);
    } else {
      history.shift();
    }
  }
  // History muss mit einer echten User-Text-Nachricht beginnen
  // (nicht assistant, nicht tool_result)
  while (history.length > 0) {
    const first = history[0];
    if (first.role === "user" && typeof first.content === "string") break;
    // assistant oder user+tool_result am Anfang entfernen
    if (
      first.role === "assistant" &&
      Array.isArray(first.content) &&
      first.content.some((b) => b.type === "tool_use") &&
      history.length >= 2
    ) {
      history.splice(0, 2); // tool_use + tool_result Paar entfernen
    } else {
      history.shift();
    }
  }
}

// --- Agent Loop ---

const MAX_CONTINUATIONS = 3;

async function handleMessage(chatId, userMessage, options = {}) {
  // Workflow-Context in den Prompt injizieren
  if (options.workflowContext) {
    const ctxStr = JSON.stringify(options.workflowContext);
    userMessage = `[WORKFLOW: ${options.workflowName || "?"} | Schritt ${options.stepNum || "?"}]\nKontext: ${ctxStr}\n\n${userMessage}`;
  }

  const { tools, definitions } = loadTools();
  const toolNames = [...tools.keys()];

  if (toolNames.length > 0) {
    console.log(`  Tools: ${toolNames.join(", ")}`);
  }

  const history = getHistory(chatId);
  history.push({ role: "user", content: userMessage });
  try { db.messages.save(chatId, "user", userMessage); } catch {}
  trimHistory(history);

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    let result;
    try {
      result = await provider.chat(getSystemPrompt(), history, definitions);
    } catch (error) {
      console.error(`  API-Fehler (Turn ${turn}):`, error.message);
      // Bei 500er: einmal retry nach 2s
      if (error.status === 500 && turn === 0) {
        console.log("  Retry in 2s...");
        await new Promise((r) => setTimeout(r, 2000));
        try {
          result = await provider.chat(getSystemPrompt(), history, definitions);
        } catch (retryErr) {
          // Fehlgeschlagene User-Nachricht entfernen
          history.pop();
          return buildResponse(`❌ API-Fehler: ${retryErr.message || "Server nicht erreichbar"}`);
        }
      } else {
        history.pop();
        return buildResponse(`❌ API-Fehler: ${error.message || "Unbekannter Fehler"}`);
      }
    }

    if (result.type === "tool_use") {
      provider.pushAssistant(history, result);
      try { db.messages.save(chatId, "assistant", history[history.length - 1].content); } catch {}

      const toolResults = [];
      for (const call of result.toolCalls) {
        const inputStr = JSON.stringify(call.input).substring(0, 120);
        console.log(`  → ${call.name}(${inputStr})`);

        let output;
        try {
          const executor = tools.get(call.name);
          if (!executor) {
            output = `Tool "${call.name}" nicht gefunden. Verfügbar: ${toolNames.join(", ")}`;
          } else {
            // chatId für Reminder/Workflow-Tools injizieren
            if (call.name === "reminder_set" && !call.input.chatId) {
              call.input.chatId = chatId;
            }
            if (call.name === "workflow_create" && !call.input.chatId) {
              call.input.chatId = chatId;
            }
            output = await executor(call.name, call.input);
          }
        } catch (error) {
          output = `Tool-Fehler: ${error.message}`;
        }

        toolResults.push({
          callId: call.id,
          content: String(output).substring(0, 10000),
        });
      }

      provider.pushToolResults(history, toolResults);
      try { db.messages.save(chatId, "user", history[history.length - 1].content); } catch {}
      continue;
    }

    // Finale Text-Antwort
    provider.pushAssistant(history, result);
    try { db.messages.save(chatId, "assistant", history[history.length - 1].content); } catch {}
    return buildResponse(result.text || "(keine Antwort)");
  }

  // Auto-Continue prüfen: Hat der Agent workflow_continue aufgerufen?
  const continueCount = options.continueCount || 0;
  if (continueCount < MAX_CONTINUATIONS) {
    try {
      const workflowTool = require("./tools/workflow");
      const cont = workflowTool.getContinueRequest();
      if (cont) {
        console.log(`  Auto-Continue (${continueCount + 1}/${MAX_CONTINUATIONS}): ${cont.status_message}`);
        const continuePrompt = `[AUTO-CONTINUE] Zwischenbericht: ${cont.status_message}\n\nFortsetzung: ${cont.remaining_work}`;
        return handleMessage(chatId, continuePrompt, { ...options, continueCount: continueCount + 1 });
      }
    } catch {}
  }

  return buildResponse("⚠️ Maximale Agent-Schritte erreicht. Versuche es mit einer einfacheren Anfrage.");
}

function buildResponse(text) {
  // Bild-Queue aus dem image-Tool abholen
  let images = [];
  try {
    const imageTool = require("./tools/image");
    images = imageTool.getQueue();
  } catch {}
  return { text, images };
}

process.on("exit", () => db.close());

module.exports = { handleMessage, clearHistory, getHistory, conversations, db };
