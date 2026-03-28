# KIASY — KI-Assistent System

Dein persönlicher KI-Assistent, selbst gehostet auf deinem eigenen Server. Kommunikation über Telegram, Web-Dashboard inklusive. Keine Cloud-Abhängigkeit, volle Kontrolle.

## Was kann KIASY?

| Feature | Beschreibung |
|---------|-------------|
| **Chat** | Natürliche Konversation in Deutsch oder Englisch |
| **Gedächtnis** | Merkt sich Fakten, Todos und Notizen dauerhaft |
| **Erinnerungen** | Zeitgesteuerte und wiederkehrende Erinnerungen |
| **Wissensbasis** | Lokale Markdown-Notizen mit Volltextsuche |
| **Websuche** | DuckDuckGo-Suche, Webseiten lesen |
| **Wetter** | Aktuelles Wetter und 5-Tage-Vorhersage |
| **Shell** | Bash-Befehle auf dem Server ausführen |
| **Dateien** | Dateien lesen, schreiben, auflisten |
| **Workflows** | Mehrstufige automatisierte Aufgaben |
| **Sprachnachrichten** | Sprache-zu-Text (Whisper) + Text-zu-Sprache (Edge-TTS) |
| **Bildgenerierung** | DALL-E Bildgenerierung (optional, braucht OpenAI Key) |
| **Smart Home** | Home Assistant Steuerung (optional) |
| **E-Mail/Kalender** | Kerio Connect Integration (optional) |
| **Selbst-Erweiterung** | Bot kann sich selbst neue Tools bauen |
| **Web-Dashboard** | Monitor, Chat, Terminal, Wissensbasis, Roadmap, Theme-Editor |

---

## Voraussetzungen

- **Ubuntu 24.04** (oder höher) / Debian 12+
- Mindestens **2 GB RAM**, 10 GB Disk
- Internetzugang
- Ein **Telegram-Account**
- **Ein LLM-Provider** (siehe unten)

### LLM-Provider — du brauchst einen

| Provider | Kosten | Qualität | Beschreibung |
|----------|--------|----------|-------------|
| **Ollama** | Kostenlos | Sehr gut | Lokal oder Cloud-Modelle. Empfehlung: `minimax-m2.7:cloud` |
| **Groq** | Kostenlos | Gut | Cloud, schnell, Rate-Limits |
| **Anthropic** | Bezahlt | Exzellent | Claude — beste Tool-Nutzung |
| **OpenAI** | Bezahlt | Sehr gut | GPT-4o |

**Tipp:** Für den Einstieg empfehlen wir **Ollama** mit dem Cloud-Modell `minimax-m2.7:cloud` — kostenlos und funktioniert hervorragend mit Deutsch und Tool-Calling.

---

## Installation

```bash
git clone https://github.com/micdede/kiasy.git
cd kiasy
bash scripts/install.sh
```

Das interaktive Install-Script führt dich durch alle Schritte:

1. **Bot-Name** — Wie soll dein Assistent heißen? (z.B. JARVIS, FRITZ, LUNA)
2. **Dein Name** — Damit der Bot dich persönlich anspricht
3. **Stadt** — Für Wetter und lokale Infos
4. **Zeitzone** — Wird automatisch erkannt
5. **Sprache** — Deutsch oder English
6. **LLM-Provider** — Mit Links wo du Accounts/Keys bekommst
7. **Telegram Bot** — Schritt-für-Schritt Anleitung
8. **Optionale Features** — Sprache, Home Assistant, Kerio, DALL-E

Am Ende werden alle Pakete installiert, die `.env` generiert und der systemd-Service eingerichtet.

### Was wird installiert?

| Komponente | Beschreibung |
|-----------|-------------|
| Node.js v24 | Runtime |
| NPM Packages | Telegram Bot, SQLite, Axios, etc. |
| Python venv | Whisper STT + Edge-TTS (optional) |
| lm-sensors | CPU-Temperaturen im Dashboard |
| SSL-Zertifikat | Selbst-signiert für das Dashboard |
| systemd Service | Automatischer Start beim Boot |

---

## Erster Start

Nach der Installation:

```bash
# Service starten
sudo systemctl start kiasy

# Logs anschauen
journalctl -u kiasy -f

# Status prüfen
systemctl status kiasy
```

### Onboarding

Beim ersten `/start` in Telegram stellt sich dein Bot vor und stellt dir ein paar Fragen, um dich kennenzulernen. Die Antworten werden im Gedächtnis gespeichert.

### Telegram-Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `/start` | Onboarding (beim ersten Mal) oder Begrüßung |
| `/hilfe` | Zeigt alle Fähigkeiten |
| `/status` | Modell, geladene Tools, Verlauf |
| `/reset` | Konversation zurücksetzen |

Ansonsten schreibst du einfach in natürlicher Sprache:

- *"Wie wird das Wetter morgen?"*
- *"Erinnere mich morgen um 8 Uhr ans Meeting"*
- *"Suche im Web nach den besten Linux-Distros"*
- *"Merke dir: Meine Lieblingsfarbe ist blau"*

Du kannst auch **Sprachnachrichten** senden — der Bot versteht sie und antwortet per Sprache.

---

## Web-Dashboard

Nach dem Start erreichbar unter:

```
https://DEIN-SERVER:3333
```

> Selbstsigniertes Zertifikat — die Browser-Warnung ist normal, einfach akzeptieren.

### Seiten

| Seite | Beschreibung |
|-------|-------------|
| **Monitor** (`/`) | Live-Dashboard mit Events in Echtzeit (SSE) |
| **Chat** (`/chat`) | Web-Chat als installierbare PWA |
| **System** (`/system`) | CPU, RAM, Disk, Temperaturen, Systembereinigung |
| **Einstellungen** (`/settings`) | Profilbild, Bot-Name, Theme, alle Konfiguration |
| **Wissensbasis** (`/notes`) | Markdown-Notizen mit Editor + Vorschau |
| **Erinnerungen** (`/reminders`) | Erinnerungen verwalten |
| **Terminal** (`/terminal`) | Web-Terminal mit Quick Actions (Restart, Update, Logs) |
| **Tools** (`/tools`) | Tools aktivieren/deaktivieren, eigene erstellen |
| **Workflows** (`/workflows`) | Mehrstufige Workflows verwalten |
| **Roadmap** (`/roadmap`) | Projekt-Roadmap / ToDo-Board |
| **Theme-Editor** (`/theme-editor`) | Themes erstellen und anpassen |
| **Smart Home** (`/ha-editor`) | Home Assistant Geräteliste bearbeiten |

### Themes

Drei eingebaute Themes: **classic** (GitHub Dark), **tron** (TRON Legacy Neon), **joy** (Lotus Cyan/Violet). Themes können im Editor bearbeitet werden — eingebaute Themes werden als Custom-Kopie gespeichert. Eigene Themes können frei erstellt werden.

---

## Update

### Per Terminal-Button

Im Web-Dashboard unter **Terminal** gibt es den **"KIASY Update"** Button. Ein Klick aktualisiert den Code und startet den Bot neu.

### Per Kommandozeile

```bash
cd ~/kiasy
bash scripts/update.sh
```

Das Update-Script:
- Holt den neuesten Code (`git pull`)
- Aktualisiert NPM + Python Dependencies
- Führt Datenbank-Migrationen aus
- Prüft auf neue `.env`-Variablen
- Aktualisiert die Service-Konfiguration
- Startet den Service automatisch neu
- Zeigt den Changelog seit dem letzten Update

---

## Einstellungen

Alle Einstellungen können auf zwei Wegen geändert werden:

### 1. Web-Dashboard (empfohlen)

Unter **Einstellungen** (`/settings`) kannst du alles konfigurieren:

- **Profil** — Profilbild hochladen (wird auch als Telegram Bot-Foto gesetzt)
- **Personalisierung** — Bot-Name, dein Name, Stadt, Sprache, Zeitzone
- **Erscheinungsbild** — Theme wählen oder im Editor anpassen
- **Monitor** — Benutzername und Passwort für das Dashboard
- **KI-Modell** — Provider, Modell, API-Keys
- **Sprache** — TTS-Stimme, Whisper-Modell
- **Telegram** — Bot-Token, Whitelist
- **Home Assistant** — URL und Token
- **E-Mail** — Kerio Connect Einstellungen
- **Wissensbasis** — Git-Backup Repository

Nach dem Speichern: "Neustart" klicken damit die Änderungen wirksam werden.

### 2. Datei `.env` direkt bearbeiten

```bash
nano ~/kiasy/.env
sudo systemctl restart kiasy
```

Alle Variablen sind in `.env.example` dokumentiert.

---

## Optionale Features

### Sprachnachrichten

Wird im Install-Script aktiviert. Braucht Python venv mit Whisper + Edge-TTS.

- **Whisper-Modelle:** `tiny` (schnell), `base` (Standard), `small`, `medium` (genauer)
- **TTS-Stimmen:** Auswahl in den Einstellungen oder unter [Edge-TTS Stimmen](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571a4c138)

### Home Assistant

1. In Home Assistant: **Profil → Langlebige Zugriffstokens → Token erstellen**
2. In den Einstellungen oder `.env`:
   ```
   HOMEASSISTANT_URL=http://homeassistant.local:8123
   HOMEASSISTANT_TOKEN=dein-token
   ```
3. Geräteliste generieren: `node scripts/generate-ha-devices.js`
4. Im Dashboard unter `/ha-editor` die kompakte Geräteliste anpassen
5. *"Schalte das Licht im Wohnzimmer ein"*

### DALL-E Bildgenerierung

Braucht einen OpenAI API-Key → [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

```
OPENAI_API_KEY=sk-proj-...
```

*"Generiere ein Bild von einem Sonnenuntergang am Meer"*

### Kerio Connect (E-Mail, Kalender, Kontakte)

Nur relevant wenn du einen Kerio Connect Mailserver betreibst. Aktiviert:
- E-Mails lesen und senden
- Kalendertermine verwalten
- Kontakte durchsuchen und anlegen
- Aufgaben und Notizen
- Automatische Mail-Überwachung (alle 60 Sekunden)

---

## Architektur

```
kiasy/
├── telegram.js          — Hauptprozess: Telegram Bot + Scheduler
├── agent.js             — Agent-Loop mit dynamischem Tool-Loading
├── monitor.js           — Web-Dashboard (HTTPS, SSE, alle Seiten)
├── voice.js             — Whisper STT + Edge-TTS
├── mail-watcher.js      — E-Mail Poller (wenn Kerio konfiguriert)
├── providers.js         — LLM-Provider Abstraction
├── lib/
│   ├── db.js            — SQLite Datenbank (better-sqlite3, WAL)
│   ├── notes-utils.js   — Wissensbasis Utilities
│   └── git-sync.js      — Git Auto-Sync für Notizen
├── tools/               — Agent-Tools (dynamisch geladen)
│   ├── shell.js         — Bash-Befehle
│   ├── files.js         — Dateien lesen/schreiben
│   ├── memory.js        — Gedächtnis
│   ├── reminder.js      — Erinnerungen
│   ├── knowledge.js     — Wissensbasis
│   ├── search.js        — Web-Suche
│   ├── weather.js       — Wetter
│   ├── web-browse.js    — Webseiten lesen
│   ├── image.js         — Bilder senden/generieren
│   ├── hardware.js      — System-Hardware-Info
│   ├── homeassistant.js — Home Assistant
│   ├── workflow.js      — Workflows
│   └── kerio-*.js       — Kerio Mail/Kalender/Kontakte
├── scripts/
│   ├── install.sh       — Interaktive Installation
│   └── update.sh        — Update-Script
├── notes/               — Wissensbasis (Markdown-Dateien)
├── certs/               — SSL-Zertifikate
├── .env                 — Konfiguration (nicht im Git)
└── .env.example         — Vorlage mit Erklärungen
```

### Datenbank

SQLite (`jarvis.db`) mit WAL-Modus. Tabellen:

| Tabelle | Zweck |
|---------|-------|
| `messages` | Chat-Verlauf |
| `memory` | Gedächtnis (facts, todos, notes) |
| `reminders` | Erinnerungen + Scheduler |
| `kb_notes` | Wissensbasis-Index (FTS5 Volltext) |
| `events` | Monitor-Events |
| `workflows` / `workflow_steps` | Mehrstufige Workflows |
| `tool_settings` | Tool Enable/Disable |
| `roadmap` | Projekt-Roadmap |
| `terminal_log` / `terminal_state` | WebTerminal-Session |

### Eigene Tools erstellen

Der Bot kann sich selbst erweitern. Jede `.js`-Datei in `tools/` wird automatisch geladen:

```javascript
// tools/mein-tool.js
const definitions = [{
  name: "mein_tool",
  description: "Beschreibung was das Tool macht",
  input_schema: {
    type: "object",
    properties: {
      param: { type: "string", description: "Ein Parameter" }
    },
    required: ["param"]
  }
}];

async function execute(name, input) {
  return "Ergebnis: " + input.param;
}

module.exports = { definitions, execute };
```

Tools können auch über das Dashboard unter `/tools` erstellt und verwaltet werden.

---

## Troubleshooting

### Bot antwortet nicht

```bash
# Service läuft?
systemctl status kiasy

# Logs anschauen
journalctl -u kiasy -f

# Häufige Ursachen:
# - TELEGRAM_TOKEN falsch → bei @BotFather prüfen
# - Deine User-ID nicht in TELEGRAM_ALLOWED_USERS
# - LLM-Provider nicht erreichbar (API-Key, URL prüfen)
```

### Dashboard nicht erreichbar

- URL: `https://SERVER-IP:3333` (mit **https**, nicht http)
- Browser-Warnung ist normal (selbstsigniertes Zertifikat)
- Port offen? `sudo ufw allow 3333`

### Sprachnachrichten funktionieren nicht

```bash
# Whisper installiert?
venv/bin/whisper --help

# ffmpeg installiert?
ffmpeg -version

# Erstes Mal: Whisper lädt das Modell herunter (kann dauern)
```

### "Module not found"

```bash
cd ~/kiasy && npm install
```

### Timezone-Fehler

Die Timezone muss im IANA-Format sein: `Europe/Berlin`, nicht `Europa/Berlin`. Liste: [Wikipedia Timezones](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

---

## Lizenz

MIT
