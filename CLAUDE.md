# JARVIS – Projekt-Kontext für Claude Code

## Was ist das?
JARVIS ist Michaels persönlicher KI-Assistent. Node.js, läuft als systemd-Service auf einem Linux Mini-PC.

## Sprache & Kommunikation
- Michael spricht Deutsch, technische Begriffe bleiben englisch
- Direkte Kommunikation, kein Geschwätz
- Bevorzugt auskommentieren statt löschen (für Fallback)

## Architektur

### Einstiegspunkte
- `telegram.js` — Hauptprozess: Telegram-Bot + Monitor-Dashboard + Mail-Watcher + Reminder- & Workflow-Scheduler
- `agent.js` — Agent-Loop (max 15 Turns, Auto-Continue bis 60) mit dynamischem Tool-Loading + System-Prompt
- `monitor.js` — HTTPS-Dashboard Port 3333 (self-signed Certs in `certs/`)

### Datenbank: jarvis.db (SQLite)
Zentrale DB in `lib/db.js` (better-sqlite3, WAL-Modus). Alle Tabellen haben FTS5-Volltext.

| Tabelle | Zweck |
|---------|-------|
| messages | Chat-Verlauf aller Kanäle |
| memory | Gedächtnis (facts, todos, notes) |
| reminders | Erinnerungen + Task-Scheduler (recurring, fail-count) |
| kb_notes | Wissensbasis-Index (FTS, Dateien in notes/ sind Source of Truth) |
| events | Monitor-Events (30 Tage, SSE + DB) |
| terminal_log / terminal_state | WebTerminal-Session + Theme-Config |
| tool_settings | Tool Enable/Disable |
| roadmap | Projekt-Roadmap/ToDo-Board |
| workflows / workflow_steps | Agentic Loops (mehrstufige Workflows) |

### Tools (tools/*.js)
Dynamisch geladen bei jeder Nachricht. Jedes Modul exportiert `{ definitions, execute }`.
Enable/Disable über `tool_settings` Tabelle + Tool-Manager UI (`/tools`).

Wichtige Tools: memory, reminder, knowledge (KB), chat-history, homeassistant, kerio-mail, workflow, web-browse, shell, files, image, search, weather

### Monitor-Dashboard (monitor.js)
Vanilla HTML/CSS/JS, konfigurierbares Theme-System (CSS-Variablen).
Themes: "classic" (GitHub Dark), "tron" (TRON Legacy Neon Cyan), Custom Themes über `/theme-editor`.

Seiten: `/` (Dashboard), `/chat` (PWA), `/system`, `/ha-editor`, `/notes`, `/reminders`, `/terminal`, `/tools`, `/workflows`, `/roadmap`, `/theme-editor`, `/settings`

### Voice (voice.js)
- STT: Whisper CLI (`venv/bin/whisper`)
- TTS: Edge-TTS CLI (`venv/bin/edge-tts`), Stimme: `de-DE-KillianNeural`

### Infrastruktur
- **JARVIS Server**: Linux Mini-PC (hostname: jarvis), Node.js v24
- **Unraid Server**: 192.168.178.20 — Ollama, SearXNG, Chatterbox TTS, Qdrant, Docling
- **Home Assistant**: 192.168.178.8:8123
- **Kerio Mail**: wrsk-mail.de (User: jarvis)
- **Service**: `sudo systemctl restart jarvis-telegram`

## Wichtige Dateien
```
telegram.js          — Hauptprozess + Bot + Scheduler
agent.js             — Agent-Loop + System-Prompt + Tool-Loading
monitor.js           — HTTPS Dashboard (alle Seiten + API, ~6000 Zeilen)
voice.js             — Whisper STT + Edge-TTS
mail-watcher.js      — IMAP Poller (60s Intervall)
lib/db.js            — Zentrale SQLite DB (jarvis.db)
lib/notes-utils.js   — Shared Utils für Wissensbasis
lib/git-sync.js      — Git Auto-Sync für notes/
tools/*.js           — Agent-Tools (dynamisch geladen)
public/favicon/      — Favicon-Dateien
certs/               — SSL-Zertifikate
notes/               — Wissensbasis (.md Dateien)
scripts/             — Install/Migrations-Scripts
```

## Konventionen
- Alles in einer Datei pro Bereich (kein Framework, kein Build-Step)
- monitor.js enthält ALLE Dashboard-Seiten als Template-Literale
- CSS über Theme-System mit `var(--...)` Variablen
- DB-Pattern: Tabelle + Prepared Statements + API-Objekt in lib/db.js
- Tool-Pattern: `{ definitions: [...], execute: async (name, input) => ... }`
- Konfiguration über `.env`

## Häufige Aufgaben
- Service neustarten: `sudo systemctl restart jarvis-telegram`
- Logs anschauen: `journalctl -u jarvis-telegram -f`
- Tool hinzufügen: Neue .js in tools/ mit definitions+execute Pattern
- Theme ändern: Settings → Erscheinungsbild oder /theme-editor
- DB inspizieren: `sqlite3 jarvis.db ".tables"` oder `sqlite3 jarvis.db "SELECT * FROM memory"`
