# Briefing: Firmen-Assistent (Fork von kiasy)

> Dieses Dokument beschreibt ein neues Projekt, das von kiasy/JARVIS abgeleitet wird.
> Übergebe es einer neuen Claude Code Session als ersten Prompt.

---

## Projekt-Kurzbeschreibung

Ein **persönlicher KI-Assistent für die Firma WRSK** (oder ähnlich), abgeleitet von [kiasy](https://github.com/micdede/kiasy). Läuft als **Docker-Container auf Unraid**. Mitarbeiter interagieren mit dem Assistenten ausschließlich über **Telegram** und **E-Mail** — der Web-Monitor ist Single-User und gehört nur dem Admin (Michael).

## Was du übernimmst (Patterns aus kiasy)

Diese Architektur-Entscheidungen haben sich bewährt und sollen beibehalten werden:

### Code-Struktur
- **Eine Datei pro Bereich** (kein Framework, kein Build-Step)
- `telegram.js` als Hauptprozess (Bot + Monitor + Scheduler)
- `agent.js` mit Agent-Loop (max 15 Turns, Auto-Continue bis 60) und dynamischem Tool-Loading
- `monitor.js` enthält **alle Dashboard-Seiten als Template-Literale**
- Konfiguration ausschließlich über `.env`

### Datenbank
- **SQLite mit better-sqlite3** (WAL-Modus)
- Zentral in `lib/db.js`: Tabelle + Prepared Statements + API-Objekt
- **FTS5-Volltextsuche** für alle Text-Tabellen (messages, memory, kb_notes, events)
- Tabellen-Pattern siehe kiasy/lib/db.js

### Tool-System
- Dynamisches Loading aus `tools/*.js`
- Pattern: `module.exports = { definitions: [...], execute: async (name, input) => ... }`
- **`input_schema`** (snake_case, NICHT camelCase!)
- Enable/Disable über DB-Tabelle `tool_settings` + Tool-Manager UI

### Monitor-Dashboard
- Vanilla HTML/CSS/JS, keine Frameworks
- **Theme-System** mit CSS-Variablen (`var(--accent)`, `var(--bg-primary)` etc.)
- Einheitlicher Header über `getNav(pageTitle)` — Logo + Seitentitel
- Auth über `MONITOR_USER`/`MONITOR_PASS` (Basic Auth)
- HTTPS Port 3333 mit self-signed Zertifikaten

### Semantisches Gedächtnis
- **Qdrant** als Vektor-DB (auf Unraid: `192.168.178.20:6333`)
- **Ollama Embeddings** mit `bge-m3` (1024 dim, multilingual)
- `lib/vector-memory.js` als zentrales Modul
- Auto-Vektorisierung neuer Nachrichten/Memory/KB
- Bei jeder Anfrage: semantischer Kontext wird in den System-Prompt injiziert

### Telegram
- `node-telegram-bot-api` mit Long-Polling
- **Polling-Recovery bei EFATAL** (automatischer Neustart nach 5s)
- `unhandledRejection` + `uncaughtException` Handler gegen Crashes
- Whitelist-System (`TELEGRAM_OWNER_CHAT_ID`)

### News-System
- Dynamische Quellen-Verwaltung (DB-Tabelle `news_sources`)
- API-Adapter (NewsAPI, NewsData, Hacker News, Generic JSON) + RSS-Parser
- Monitor-Seite `/news` mit CRUD + Test-Button

### Workflows
- Mehrstufige Agentic Loops (Tabellen `workflows` + `workflow_steps`)
- Scheduler im Hauptprozess (60s Intervall)

---

## Was anders wird

### 1. Multi-User für Telegram + E-Mail
Aktuell: Nur Michael darf JARVIS nutzen (Whitelist `TELEGRAM_WHITELIST` mit einer ID).
Neu: **Beliebig viele Mitarbeiter** können den Assistenten nutzen.

**Konsequenzen:**
- DB-Tabelle `users` mit: `id`, `telegram_id`, `email`, `name`, `role` (admin/user), `enabled`, `created`
- `messages.chat_id` referenziert weiterhin Telegram Chat ID, aber pro User
- Memory-Einträge sollten **pro User** sein (`memory.user_id` Spalte hinzufügen)
- Reminders pro User
- Berechtigungs-Check in `telegram.js` und `mail-watcher.js`: Nur registrierte User dürfen
- E-Mail Whitelist: Mitarbeiter-Adressen aus DB statt aus `.env`

### 2. E-Mail als gleichwertiger Kanal
Aktuell: `mail-watcher.js` pollt nur INBOX und benachrichtigt Michael.
Neu: **E-Mails von Mitarbeitern werden vom Agent verarbeitet wie Telegram-Nachrichten.**

**Konsequenzen:**
- IMAP-Poller erkennt User anhand der Absender-Adresse
- Agent verarbeitet die Mail wie eine Chat-Nachricht
- Antwort wird per SMTP zurückgesendet
- Threading erhalten (References-Header)
- Anhänge handhaben (PDF, Bilder)

### 3. Monitor bleibt Single-User
Aktuell: Schon so (nur du loggst dich ein).
Neu: **Bleibt unverändert** — nur der Admin (du) hat Zugriff.

**Aber:** Monitor bekommt neue Seite `/users` zur Mitarbeiter-Verwaltung.

### 4. Tool-Auswahl anpassen
**Entfernen** (privat, nicht firmenrelevant):
- Home Assistant Tools (`tools/homeassistant.js`)
- Persönliche Reminder-Tools (oder anpassen für Firmen-Reminder)
- Community Chat
- BTC Price (`tools/btc-price.js`)
- Mobile UI (`/m`)

**Beibehalten:**
- Mail (Lesen/Senden)
- Kalender (CalDAV — wahrscheinlich Kerio)
- Knowledge Base (für Firmen-Wissen)
- News
- Web-Suche (SearXNG/DuckDuckGo)
- Workflows
- Memory (mit User-Isolation)
- Semantisches Gedächtnis
- Documents (PDF, Word, Excel)

**Neu hinzufügen** (Beispiele, mit Michael abstimmen):
- CRM-Anbindung (falls vorhanden)
- Projekt-Management (Linear, Jira, etc.)
- Datei-Server-Zugriff (Firmen-Shares)
- Aufgaben/Tickets
- Mitarbeiter-Suche (LDAP/Active Directory?)

### 5. Branding
- Eigener Bot-Name (z.B. "WRSKi", "FirmaBot", abstimmen)
- Eigenes Avatar/Logo
- Eigene Theme-Farben
- E-Mail-Signatur

---

## Docker-Setup

Das Projekt soll als Docker-Container auf Unraid laufen.

### Anforderungen
- **Node.js 24** (für `node --watch` und neueste better-sqlite3)
- **Voice-Features (Whisper/Edge-TTS) erstmal weglassen** — vereinfacht das Image massiv
- **Claude Code muss im Container laufen können** — damit Michael per Terminal direkt Änderungen am Live-System machen kann
- Persistente Volumes:
  - `/data` — DB, notes, certs, .env
  - `/logs` — Logs
- Ports:
  - 3333 (Monitor HTTPS)

### Was zu liefern ist
1. **Dockerfile** — Multi-stage Build mit Node 24, Claude Code installiert
2. **docker-compose.yml** — für lokale Entwicklung
3. **Unraid Template (XML)** — für Unraid Community Apps
4. **Setup-Script** — initiale `.env` und DB anlegen
5. **README.md** mit Deployment-Anleitung

### Claude Code im Container
- Per `npm install -g @anthropic-ai/claude-code` (oder aktuelles Paket)
- API-Key per Environment-Variable
- Workspace = `/app` (das gemountete Volume)
- Zugang per `docker exec -it <container> claude` oder Web-Terminal im Monitor

---

## Empfohlene Reihenfolge

1. **Repo aufsetzen** — Fork von kiasy, neues Verzeichnis (z.B. `wrsk-assistant`), eigenes Git-Remote
2. **CLAUDE.md anpassen** — Neuer Projekt-Kontext, neue Architektur
3. **`.env.example` aufräumen** — Nur die relevanten Variablen
4. **Tools ausmisten** — Entfernen was nicht gebraucht wird, neue stubs anlegen
5. **DB-Schema erweitern** — `users` Tabelle, `user_id` Spalten
6. **Multi-User in telegram.js** — User-Erkennung, Berechtigungs-Check
7. **Mail als Agent-Kanal** — `mail-watcher.js` umbauen
8. **Monitor-Seite `/users`** — Mitarbeiter-Verwaltung
9. **Branding** — Theme, Logo, Bot-Name
10. **Dockerfile + Unraid-Template** — Deployment

---

## Wichtige Hinweise für die neue Session

- **Sprache:** Michael spricht Deutsch, technische Begriffe bleiben englisch. Direkte Kommunikation, kein Geschwätz.
- **Code-Stil:** Bevorzugt auskommentieren statt löschen (für Fallback). Keine unnötigen Abstraktionen, keine Frameworks.
- **Auto-Commit:** Nach jeder abgeschlossenen Arbeit selbstständig committen und pushen — nicht warten bis Michael fragt.
- **Testen:** Michael testet gerne interaktiv. Vor "Fertig"-Meldung wenn möglich selbst testen.
- **Infrastruktur:** Unraid-Server `192.168.178.20` (Ollama, Qdrant, SearXNG), Kerio Mail (`wrsk-mail.de`).
- **Datenbank-Pattern:** Tabelle in `lib/db.js`, Prepared Statements gruppiert, API-Objekt mit Methoden, am Ende exportieren.
- **Tool-Pattern:** `input_schema` (snake_case!), kurze Beschreibungen, sinnvolle Defaults.

---

## Erste Frage an die neue Session

> "Lies `docs/firmen-assistent-briefing.md` und gib mir einen kurzen Plan, wie wir das Projekt strukturieren. Wir starten mit Schritt 1 (Repo aufsetzen)."
