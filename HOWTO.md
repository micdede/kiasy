# 🤖 JARVIS — Dein persönlicher KI-Assistent

**Was ist JARVIS?**
JARVIS ist ein selbstgehosteter KI-Assistent, der über Telegram mit dir kommuniziert. Er kann Dateien lesen/schreiben, im Web suchen, E-Mails verwalten, dein Smart Home steuern, Bilder generieren, Termine verwalten und vieles mehr. Alles läuft auf deinem eigenen Server — keine Cloud, volle Kontrolle.

---

## 📋 Voraussetzungen

- Linux-Server (Ubuntu/Debian empfohlen)
- Mindestens 2 GB RAM, 10 GB Disk
- Internetzugang
- Ein Telegram-Account

---

## 🔧 Installation Schritt für Schritt

### 1. System-Pakete installieren

```bash
sudo apt update && sudo apt install -y curl git ffmpeg openssl python3 python3-venv
```

### 2. Node.js 24 installieren

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

Prüfen: `node -v` sollte v24.x zeigen.

### 3. Projekt klonen

```bash
git clone git@github.com:DEIN-USER/DEIN-REPO.git bot-verzeichnis
cd bot-verzeichnis
```

### 4. Node-Abhängigkeiten installieren

```bash
npm install --production
```

### 5. Python-Umgebung für Whisper + Edge-TTS

```bash
python3 -m venv venv
venv/bin/pip install edge-tts openai-whisper
```

Whisper wird für Sprachnachrichten-Erkennung gebraucht, Edge-TTS für Sprachausgabe.

### 6. Verzeichnisse anlegen

```bash
mkdir -p temp logs notes certs
```

### 7. SSL-Zertifikat für das Dashboard generieren

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -subj "/CN=jarvis/O=JARVIS/C=DE"
```

### 8. Leere Datendateien anlegen

```bash
echo '{"facts":[],"todos":[],"notes":[]}' > memory.json
echo '[]' > reminders.json
```

### 9. Konfigurationsdatei erstellen

```bash
cp .env.example .env
nano .env
```

Siehe Abschnitt "Konfiguration" weiter unten.

> **Tipp:** Es gibt auch ein automatisches Setup-Script, das Schritte 1–8 auf einmal erledigt:
> ```bash
> bash scripts/restore.sh
> ```

---

## 🤖 Telegram Bot einrichten

1. Öffne Telegram und suche **@BotFather**
2. Sende `/newbot`
3. Wähle einen Namen (z.B. "Mein JARVIS") und einen Username (z.B. `mein_jarvis_bot`)
4. Du bekommst einen **Token** — kopiere ihn (sieht aus wie `123456789:ABCdefGHI...`)
5. **Deine User-ID herausfinden:** Suche `@userinfobot` in Telegram, starte ihn, und er zeigt dir deine numerische ID (z.B. `987654321`)
6. Trage beides in die `.env` ein (siehe nächster Abschnitt)

---

## ⚙️ Konfiguration (.env)

Öffne die `.env` mit einem Editor und passe sie an.

### Minimalbeispiel

```bash
# === PFLICHT ===

# Telegram
TELEGRAM_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_ALLOWED_USERS=987654321

# LLM Provider (wähle EINEN)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-dein-key-hier

# === OPTIONAL ===

# Allgemein
MAX_TOKENS=4096
WHISPER_MODEL=base
TTS_VOICE=de-DE-KillianNeural

# Monitor Dashboard (Weboberfläche)
MONITOR_PORT=3333
MONITOR_USER=admin
MONITOR_PASS=dein-passwort

# Kerio Mail (nur wenn du Kerio Connect hast)
KERIO_HOST=mail.example.com
KERIO_USER=dein-user
KERIO_PASSWORD=dein-passwort
KERIO_FROM=Name <user@example.com>

# Home Assistant (nur wenn du HA hast)
HOMEASSISTANT_URL=http://192.168.x.x:8123
HOMEASSISTANT_TOKEN=dein-ha-long-lived-token

# DALL-E Bildgenerierung (braucht OpenAI Key)
OPENAI_API_KEY=sk-proj-...

# Wissensbasis Git-Backup (optional)
GITHUB_NOTES_REPO=git@github.com:user/jarvis-notes.git
```

### Alle Variablen erklärt

| Variable | Beschreibung |
|----------|-------------|
| `TELEGRAM_TOKEN` | Bot-Token vom BotFather |
| `TELEGRAM_ALLOWED_USERS` | Komma-getrennte Telegram User-IDs. Nur diese User dürfen den Bot nutzen. Leer = alle erlaubt |
| `LLM_PROVIDER` | `anthropic`, `ollama`, `groq` oder `openai` |
| `ANTHROPIC_API_KEY` | API-Key von console.anthropic.com |
| `CLAUDE_MODEL` | Anthropic-Modell (Standard: `claude-sonnet-4-20250514`) |
| `OLLAMA_BASE_URL` | Ollama API-URL (z.B. `http://localhost:11434/v1`) |
| `OLLAMA_MODEL` | Ollama-Modell (z.B. `llama3.1`) |
| `GROQ_API_KEY` | Groq API-Key |
| `GROQ_MODEL` | Groq-Modell (z.B. `llama-3.1-70b-versatile`) |
| `OPENAI_API_KEY` | OpenAI API-Key (für GPT-4o und/oder DALL-E) |
| `OPENAI_MODEL` | OpenAI-Modell (z.B. `gpt-4o`) |
| `MAX_TOKENS` | Maximale Antwortlänge (Standard: 4096) |
| `WHISPER_MODEL` | Spracherkennung: `tiny` (schnell), `base` (gut), `small`/`medium` (besser aber langsamer) |
| `TTS_VOICE` | Stimme für Sprachausgabe (Standard: `de-DE-KillianNeural`) |
| `MONITOR_PORT` | Port fürs Web-Dashboard (Standard: 3333) |
| `MONITOR_USER` / `MONITOR_PASS` | Login fürs Dashboard. Ohne = kein Passwortschutz |
| `KERIO_HOST` | Kerio Connect Hostname |
| `KERIO_USER` / `KERIO_PASSWORD` | Kerio-Zugangsdaten |
| `KERIO_FROM` | Absender für E-Mails |
| `HOMEASSISTANT_URL` | Home Assistant URL |
| `HOMEASSISTANT_TOKEN` | HA Long-Lived Access Token |
| `GITHUB_NOTES_REPO` | Git-Repo für Wissensbasis-Backup |

---

## 🧠 LLM-Provider wählen

JARVIS unterstützt 4 LLM-Provider. Du brauchst nur **einen**.

### Anthropic (empfohlen)

- Beste Qualität, besonders gut mit Tools
- API-Key holen: https://console.anthropic.com
- Kostet ca. $3 pro Million Input-Tokens

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-20250514
```

### Ollama (kostenlos, lokal)

- Läuft auf deinem eigenen Server, keine API-Kosten
- Braucht starke GPU oder viel RAM
- Installation: https://ollama.ai

```bash
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=llama3.1
```

### Groq (kostenlos, schnell)

- Sehr schnelle Inferenz, kostenloser Tier verfügbar
- API-Key: https://console.groq.com

```bash
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.1-70b-versatile
```

### OpenAI

- GPT-4o und andere OpenAI-Modelle
- API-Key: https://platform.openai.com

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o
```

---

## 🚀 Starten

### Direkt starten (zum Testen)

```bash
node telegram.js
```

Du siehst die Startmeldung mit Bot-Name und geladenem Modell. Jetzt kannst du dem Bot in Telegram schreiben!

### Als systemd-Service (für Dauerbetrieb)

```bash
# Service-Datei kopieren (Pfade in der Datei ggf. anpassen!)
sudo cp jarvis-telegram.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable jarvis-telegram
sudo systemctl start jarvis-telegram
```

**Wichtig:** In der Service-Datei stehen `User` und `WorkingDirectory` mit Platzhaltern. Das install.sh Script setzt diese automatisch — bei manueller Installation musst du beides an deinen Benutzernamen und Pfad anpassen!

### Nützliche Service-Befehle

```bash
sudo systemctl status jarvis-telegram    # Status anzeigen
sudo systemctl restart jarvis-telegram   # Neustarten
sudo systemctl stop jarvis-telegram      # Stoppen
sudo journalctl -u jarvis-telegram -f    # Live-Logs anschauen
```

---

## 📊 Monitor Dashboard

Nach dem Start erreichst du das Web-Dashboard unter:

```
https://DEIN-SERVER:3333
```

> Selbstsigniertes Zertifikat — Browser-Warnung ist normal, einfach akzeptieren.

### Seiten im Dashboard

| Route | Beschreibung |
|-------|-------------|
| `/` | Live-Dashboard mit allen Logs in Echtzeit |
| `/ha-editor` | Smart Home Geräte-Editor |
| `/notes` | Wissensbasis-Editor (Notizen erstellen/bearbeiten) |
| `/reminders` | Erinnerungen verwalten |
| `/terminal` | Web-Terminal (Shell-Befehle ausführen) |
| `/settings` | Einstellungen (.env bearbeiten, Service neustarten) |

---

## 🔌 Optionale Features

### Home Assistant Integration

Wenn du Home Assistant hast:

1. In HA: **Profil → Langlebige Zugriffstoken → Token erstellen**
2. In `.env` setzen:
   ```bash
   HOMEASSISTANT_URL=http://192.168.x.x:8123
   HOMEASSISTANT_TOKEN=dein-token
   ```
3. Geräteliste generieren:
   ```bash
   node scripts/generate-ha-devices.js
   ```
4. `ha-devices-compact.md` im Dashboard-Editor (`/ha-editor`) anpassen
5. Dann kannst du sagen: *"Schalte das Licht im Wohnzimmer ein"*

### Kerio Mail/Kalender/Kontakte

Wenn du Kerio Connect hast, setze die `KERIO_*` Variablen in der `.env`. JARVIS kann dann:
- E-Mails lesen und senden
- Kalendertermine verwalten
- Kontakte durchsuchen und anlegen
- Aufgaben und Notizen verwalten

Neue Mails werden automatisch alle 60 Sekunden abgerufen.

### DALL-E Bildgenerierung

Setze `OPENAI_API_KEY` in der `.env`. Dann kannst du sagen: *"Generiere ein Bild von einem Sonnenuntergang am Meer"*

### Wissensbasis Git-Backup

Deine Notizen können automatisch zu einem Git-Repo synchronisiert werden:

```bash
cd notes && git init && git remote add origin git@github.com:dein-user/jarvis-notes.git
```

In `.env`:
```bash
GITHUB_NOTES_REPO=git@github.com:dein-user/jarvis-notes.git
```

---

## 🛠 Alle JARVIS-Fähigkeiten

| Fähigkeit | Was es kann |
|-----------|------------|
| **Shell** | Bash-Befehle auf dem Server ausführen |
| **Dateien** | Dateien lesen, schreiben, auflisten (inkl. PDFs) |
| **Gedächtnis** | Fakten, Todos und Notizen dauerhaft merken |
| **Erinnerungen** | Zeitgesteuerte Erinnerungen setzen |
| **Websuche** | Im Internet suchen (DuckDuckGo + SearXNG) |
| **Wetter** | Aktuelles Wetter und 5-Tage-Vorhersage |
| **Bilder** | Bilder senden und mit DALL-E generieren |
| **E-Mail** | E-Mails lesen, schreiben und senden (Kerio) |
| **Kalender** | Termine anzeigen, erstellen und löschen (Kerio CalDAV) |
| **Kontakte** | Kontakte suchen und anlegen (Kerio CardDAV) |
| **Aufgaben** | Aufgaben verwalten (Kerio Tasks) |
| **Notizen** | Kerio-Notizen erstellen und lesen |
| **Smart Home** | Geräte schalten, Status abfragen, Verlauf anzeigen (Home Assistant) |
| **Wissensbasis** | Markdown-Notizen erstellen, suchen, bearbeiten |
| **Chat-Suche** | Frühere Gespräche durchsuchen |
| **Sprachnachrichten** | Sprachnachrichten verstehen und per Sprache antworten |

---

## 📱 Telegram-Befehle

| Befehl | Beschreibung |
|--------|-------------|
| `/hilfe` oder `/start` | Zeigt alle Fähigkeiten und Hilfetext |
| `/reset` | Löscht den Gesprächsverlauf (Neustart) |
| `/status` | Zeigt Modell, geladene Tools, Verlauf-Länge |

Ansonsten schreibst du JARVIS einfach in natürlicher Sprache. Beispiele:

- *"Wie wird das Wetter morgen in Hamburg?"*
- *"Erinnere mich morgen um 8 Uhr ans Meeting"*
- *"Schalte das Licht im Wohnzimmer aus"*
- *"Lies meine neuen E-Mails"*
- *"Welche Termine habe ich diese Woche?"*
- *"Suche im Internet nach den besten Pizza-Rezepten"*
- *"Merke dir: Meine Lieblingspizza ist Margherita"*

Du kannst auch **Sprachnachrichten** senden — JARVIS versteht sie und antwortet ebenfalls per Sprache.

---

## 💡 Tipps & Troubleshooting

### Bot antwortet nicht?

- Prüfe ob der Service läuft: `sudo systemctl status jarvis-telegram`
- Logs anschauen: `sudo journalctl -u jarvis-telegram -f`
- Ist deine User-ID in `TELEGRAM_ALLOWED_USERS`?
- Ist der API-Key korrekt?

### Sprachnachrichten funktionieren nicht?

- `venv/bin/whisper --help` muss funktionieren
- `ffmpeg -version` muss installiert sein
- Whisper lädt beim ersten Mal das Modell herunter (kann dauern)

### Dashboard nicht erreichbar?

- URL: `https://SERVER-IP:3333` (mit **https**, nicht http)
- Browser-Warnung wegen selbstsigniertem Zertifikat ist normal
- Port 3333 muss in der Firewall offen sein: `sudo ufw allow 3333`

### "Module not found" Fehler?

```bash
cd ~/bot-verzeichnis && npm install
```

### Service nach Code-Änderungen neustarten

```bash
sudo systemctl restart jarvis-telegram
```
