# JARVIS → Executive Assistant — Session-Briefing

> Standalone-Briefing für eine neue Claude-Session, die das JARVIS-Projekt vom Personal-POC zu einem **geschäftsfähigen KI-Assistenten für Führungskräfte** auf **NVIDIA Jetson Orin Nano Super** weiterentwickeln soll.
>
> Lesedauer ca. 10 Minuten. Sollte ohne weiteres Vorwissen reichen, um sofort produktiv zu werden.

---

## 1. TL;DR

JARVIS ist heute ein voll funktionsfähiger persönlicher KI-Assistent von Michael Dedecke — Container-Stack auf einem Mini-PC, Telegram-Bot + iOS-App als Clients, ~17 Tools (Mail, Kalender, Wissensbasis, Smart-Home, Bildgenerierung, ...). Er funktioniert seit Monaten produktiv für genau einen User (Single-Tenant, Hard-Coded-Persönlichkeit, Basic-Auth).

**Die Mission**: dieselbe Codebase zum Produkt **„Executive Assistant"** ausbauen, das auf einem **NVIDIA Jetson Orin Nano Super** (67 TOPS, 8 GB LPDDR5, ca. 250 €, Dezember 2024) als Standalone-Box läuft, an Führungskräfte verkauft wird, und in deren Büro/Office Datenhoheit + DSGVO-Compliance liefert. Plug-and-Play-Box, lokale LLM, Cloud nur als Fallback.

---

## 2. Was JARVIS heute ist (Stand Mai 2026)

### Architektur

Container-Stack (`docker compose`), läuft auf einem Mini-PC im Heimnetz:

| Container | Image | Zweck |
|-----------|-------|-------|
| `kiasy-core` | custom Node.js 24 | Agent-Loop, Tools, Telegram-Bot, Mail-Watcher, Scheduler, REST/SSE-API |
| `kiasy-monitor` | custom Node.js 24 | Server-rendered Web-UI (HTMX-Style, ein File ~6000 Zeilen) |
| `caddy` | `caddy:2-alpine` | TLS-Termination, LAN + Tailscale (Let's Encrypt via Tailscale-Socket) |
| `ollama` | `ollama/ollama` | LLM-Proxy (heute Cloud-Modelle wie `qwen3-coder:480b-cloud`) |
| `whisper` | `onerahmet/openai-whisper-asr-webservice` | STT, faster-whisper, CPU |
| `piper` | `rhasspy/wyoming-piper` | TTS, lokal |
| `qdrant` | `qdrant/qdrant` | Vector-Memory (bge-m3 Embeddings) |
| `searxng` | `searxng/searxng` | Meta-Suche |

**Reverse-Proxy**: Caddy → einziger exposed Port (443). Container reden untereinander über Docker-DNS.

**Datenpfade**:
- `./data/jarvis.db` — SQLite (WAL), Single-Source-of-Truth für alles (Messages, Memory, Reminders, KB-Index, Workflows, Settings, Tool-Settings)
- `./notes/` — Markdown-KB mit Git-Auto-Sync (deprecated; CalDAV via Kerio hat das in v2 abgelöst)
- `./core/tools/` — Tool-Module (Hot-Reload, Tool-Generator schreibt hierhin)
- `./data/system-prompt.txt` — editierbarer System-Prompt (Hot-Reload)

### Clients

1. **Telegram-Bot** (Original-Interface, Long-Polling outbound, Whitelist-Auth) — Voice-Messages werden zu Text → Agent → Antwort als Text **und/oder** Voice (konfigurierbar pro Modus: `auto`/`text`/`voice`/`both`).
2. **iOS-App** (`ios/JarvisApp`, SwiftUI, XcodeGen-basiert, Bundle-ID `de.dedecke.jarvis`) — Push-to-Talk + Tippen, 3 TTS-Backends (iOS-System / Piper-Server / Edge-TTS-Server), Tron-Theme, **iCloud-KV-Sync** für Settings, **Server-History-Reload** beim Start. Tailscale-erreichbar weltweit über `https://jarvis.tailb8844c.ts.net`.
3. **Monitor-Web-UI** — admin-zentrisch: Tools verwalten, Memory, Reminders, Workflows, Delegations, Labs, Tools-Generator, System-Prompt-Editor, Settings, Health, Logs, Backup. KEINE Chat-Page (deprecated).

### Tools (heute, alle in `core/tools/*.js`, dynamisch geladen)

Wichtigste:
- `memory` (facts/todos/notes), `reminder` (mit Recurring + Fail-Count), `chat-history`
- `knowledge` (FTS5), `web-browse`, `search` (SearXNG), `weather` (Open-Meteo)
- `mail` + `caldav` (Kerio Connect, IMAP/SMTP + CalDAV → Events/Tasks/Notes)
- `homeassistant` (Get/Toggle/Service/History)
- `image` (Pollinations.ai — gratis, kein Key)
- `delegation` (Aufgabe an Person delegieren → Mail → Auto-Follow-up → Status-Tracking)
- `workflow` (mehrstufige Agent-Loops mit Conditions)
- `shell`, `files`, `language-practice` (Übersetzen + TTS für Aussprache)

Tools haben einheitliches Pattern:
```js
export const definitions = [{ name, description, input_schema }];
export async function execute(name, input, ctx = {}) { /* ctx.chatId verfügbar */ }
```

### Killer-Feature: KI-Tool-Generator

Im Monitor `/tools` → Tab „🤖 KI-Generator". Beschreibst was du brauchst → `qwen3-coder:480b-cloud` schreibt dir das Tool, du kannst iterativ refinen, im Sandkasten testen, speichern → Tool ist sofort live. Volume-Mount sorgt für Persistenz über Container-Recreate hinweg.

### Provider-System (`core/lib/providers.js`)

Drei Rollen: `chat` (Hauptantworten), `cheap` (Klassifikation, Routing), `embed` (bge-m3), `code` (Tool-Generator). Provider: `ollama` (default, Cloud-Modelle) oder `anthropic`. **Auto-Routing**: bei Cloud-Ausfall fällt das System auf `cheap` zurück (30s Cooldown).

---

## 3. Was funktioniert gut

- **Tool-Pattern** ist sauber, neue Tools in 5 Minuten geschrieben. KI-Generator senkt Schwelle nochmal massiv.
- **Container-Stack** ist portable — kann morgen 1:1 auf andere Hardware.
- **Edge-TTS Killian** ist die mit Abstand beste DE-Stimme im Test (Microsoft-Cloud, gratis, via Python-CLI im Container).
- **CalDAV-Integration** mit Kerio funktioniert für Events, Tasks UND Notes (eine Quelle, drei Sichten).
- **Delegation-Workflow** ist ein echtes Killer-Feature für Wissensarbeiter — „delegier Oliver diese drei Aufgaben, fass alle 2 Tage nach" → läuft autonom.
- **Hot-Reload überall**: System-Prompt, Tools, Mail-Sig — Änderung speichern, nächste Anfrage hat's schon.

## 4. Was nicht funktioniert / fehlt für Business

### Blocker für Geschäftstauglichkeit
- **Single-Tenant**. Alles geht von einem User aus, eine Identität, eine Konfiguration. Keine User-Tabelle, keine Tenant-Trennung.
- **Auth ist Basic** (HTTP Basic-Auth aus `.env`). Keine Sessions, keine MFA, keine OIDC, keine Rollen.
- **Hardcoded Persönlichkeit** ("JARVIS", deutsch, technische Sprache). Bot-Name ist konfigurierbar (`BOT_NAME`), aber Stimme/Sprache/System-Prompt-Default nicht User-spezifisch.
- **Keine Audit-Logs** im compliance-Sinn. Es gibt eine `events`-Tabelle (30-Tage-Cleanup), aber nicht tamper-evident, nicht signiert, nicht exportierbar in einem Standard-Format.
- **DSGVO**: kein Daten-Export-Tool, kein Right-to-be-Forgotten-Workflow, keine Datenschutz-Doku, keine Verzeichnisse von Verarbeitungstätigkeiten.
- **Backups manuell** (`scripts/backup.sh`, Cron auf Host). Kein Off-Site, kein Restore-Test, keine Verschlüsselung at-rest.
- **Keine Tests** (weder Unit noch Integration).
- **Keine API-Versionierung** — Brüche treffen iOS-App + Telegram-Code direkt.
- **Konfiguration über `.env`** — fundamental nicht multi-tenant-fähig.

### Fehlt einfach noch
- Mobile App nur iOS (Android offen).
- Kein Onboarding-Flow für Endnutzer (alles über `.env` + manuelles Setup).
- Kein Branding-/White-Label-System (Theme-Editor existiert, aber nicht für Multi-Tenant).
- Keine Subscription-/Billing-Integration.
- Keine SLAs, kein Support-Workflow.

---

## 5. Hardware-Plan: Jetson Orin Nano Super

### Specs (Dezember 2024 Release)
- 67 INT8 TOPS (mit „Super"-Mode-Boost gegenüber Vorgänger)
- 8 GB LPDDR5 RAM (102 GB/s Bandbreite)
- 1024 CUDA-Cores (Ampere), 32 Tensor-Cores
- 25 W TDP konfigurierbar (15 W Eco-Mode möglich)
- M.2-Slot für NVMe-SSD
- Preis: ~250 € Dev-Kit
- OS: JetPack 6 (Ubuntu 22.04 + CUDA 12)

### Was lokal läuft (realistisch)
- **LLM**: Ollama mit 7-8B Modellen quantisiert (Q4_K_M ~5 GB VRAM-äquivalent). Kandidaten:
  - `qwen2.5:7b-instruct` (gut für DE)
  - `llama-3.1:8b-instruct`
  - `gemma2:9b-it` (Google, sehr gut für Multilingual)
  - Tool-Calling muss explizit getestet werden — nicht jedes Edge-LLM kann es zuverlässig
- **STT**: Whisper auf CUDA — `large-v3` flüssig (CPU heute: `medium`), Latenz fällt von ~5s auf ~1s
- **TTS**: Piper auf CUDA (existiert experimentell), oder weiter auf CPU (genug Power). Edge-TTS bleibt Cloud-Fallback.
- **Embeddings**: bge-m3 auf CUDA → faster-bulk-embed möglich
- **Qdrant**: läuft problemlos, Vector-DB ist nicht GPU-bound
- **Caddy + Monitor + Core**: native Node, kein Stress

### Was Cloud bleiben kann (begründet)
- **Edge-TTS Killian** ist hörbar besser als Piper-DE — als Premium-Option behalten
- **Größere LLM für komplexe Tasks** (z.B. `qwen3-coder:480b-cloud` für Tool-Generator) — Optional, mit User-Consent
- **Web-Suche** (SearXNG kann lokal, aber Sources sind eh extern)

### Risiken
- **Thermals**: 25W in passivem Gehäuse kann throttling triggern → aktiver Kühler oder thermisches Re-Design
- **Storage**: 8GB RAM ist eng wenn LLM (~5GB) + Whisper (~2GB) + Rest gleichzeitig → Swapping vermeiden, eventuell nur LLM resident, Whisper on-demand
- **Compatibility**: Ollama auf ARM64 + CUDA-Jetson — funktioniert, aber Build-from-Source kann nötig sein

---

## 6. Was bleibt, was wird neu

### Übernehmen (1:1 oder leicht angepasst)
- Container-Architektur
- Tool-Pattern + KI-Tool-Generator
- DB-Schema (SQLite reicht für Single-Box, multi-tenant später separieren)
- Delegation-Workflow
- CalDAV-Integration
- iOS-App-Codebase als Basis

### Anpassen
- **Telegram** wird optional — Business-Kunden bevorzugen App+Web. Bleibt für interne Nutzung & Power-User.
- **iOS-App** muss App-Store-tauglich werden (Privacy-Manifest, kein Hard-Coded-Backend, Onboarding, MDM-Distribution für Firmen-iPhones)
- **Settings-Page** muss von „global ENV" auf „pro User+Tenant" umgebaut werden
- **System-Prompt** muss pro User customizable sein (heute global pro Box)
- **Auth** muss von Basic auf JWT/OIDC, mit MFA, mit Rollen (Owner, Admin, User)

### Komplett neu
- **User/Tenant-Tabellen** im DB-Schema
- **Admin-Panel** für Tenant-Inhaber (User anlegen, Rollen vergeben, Daten exportieren)
- **DSGVO-Werkzeuge**: Datenexport (JSON/CSV), Lösch-Workflow, Verarbeitungs-Verzeichnisse, AVV-Vorlage
- **Audit-Log** mit Hash-Chaining (Tamper-Evidence)
- **Automatische Backups** mit Verschlüsselung (S3-kompatibel z.B. Hetzner Storage Box, MinIO)
- **Onboarding-Flow** (Box auspacken → QR-Code → App-Setup → in 5 Minuten produktiv)
- **Use-Case-spezifische Tools für Führungskräfte**:
  - **Termin-Vorbereitung**: 30 Min vor Meeting Briefing-Mail mit Teilnehmer-Profilen, vorherigen Mails, Talking Points
  - **Mail-Triage**: Posteingang priorisieren, Zusammenfassungen, Antwort-Vorschläge zur Freigabe
  - **Meeting-Notizen**: Audio-Mitschnitt → Transkript → Action-Items + Owner extrahieren → Delegation
  - **Reise-Planung**: Flüge + Hotel + Termine → ein zusammenhängender Plan, Konflikte erkennen
  - **Read-It-Later → Audio-Brief**: News/Mails der Woche als 10-Minuten-Podcast vorlesen lassen
  - **Vorbereitung Präsentationen**: aus Stichpunkten → strukturierter Outline + Recherche
- **Standardisiertes Mobile Device Management** für Firmenkunden (Box im Office, App auf 5 Mitarbeiter-Geräten)

---

## 7. Empfohlene Reihenfolge der Arbeit

1. **Hardware-Validierung zuerst** (1-2 Wochen)
   - Jetson Orin Nano Super beschaffen
   - JetPack 6 installieren, docker-compose-Stack rüberportieren
   - Ollama mit `qwen2.5:7b-instruct` benchmarken (Tool-Calling-Reliability + Latenz)
   - Whisper-CUDA testen
   - Stromverbrauch + Thermals unter Last messen
   - **Go/No-Go-Entscheidung**: läuft der Stack akzeptabel, oder muss man auf Orin NX (mehr RAM) gehen?

2. **Multi-Tenant-Refactor** (4-6 Wochen)
   - DB-Schema: `tenants`, `users`, alle Datentabellen mit `tenant_id`
   - Auth: Migration auf JWT, OIDC-Anbindung optional (Microsoft Entra ID für Business)
   - Settings: pro Tenant + pro User Layer
   - Tool-Berechtigungen: Welche Tools darf welcher User?

3. **DSGVO-Foundation** (2 Wochen)
   - Audit-Log
   - Datenexport-Endpunkt
   - Lösch-Workflow mit Cascade
   - Datenschutz-Dokumentation als Boilerplate für Vertrieb

4. **Use-Case-Tools für Führungskräfte** (parallel, fortlaufend)
   - Beginn mit Termin-Vorbereitung (großer ROI, baut auf bestehender CalDAV-Integration auf)

5. **Onboarding + Branding** (3-4 Wochen)
   - Setup-Wizard via Captive-Portal beim Box-Erststart
   - White-Label-Konfiguration

6. **Mobile**: iOS härten, Android-App planen (eigenes Thema)

---

## 8. Wichtige Dateien & Pfade (Code-Orientierung)

```
/home/mcde/kiasy/
├── docker-compose.yml          — Stack-Definition
├── ARCHITECTURE.md             — v2-Konzept
├── BRIEFING.md                 — DAS HIER
├── core/
│   ├── index.js                — Express-API + alle Endpoints (~1500 Zeilen)
│   ├── lib/
│   │   ├── agent.js            — Agent-Loop mit Tool-Use
│   │   ├── providers.js        — LLM-Provider (Ollama/Anthropic)
│   │   ├── db.js               — SQLite-Layer
│   │   ├── tools.js            — Tool-Loader
│   │   ├── tool-generator.js   — KI-Tool-Generator
│   │   └── ...
│   └── tools/                  — Alle Agent-Tools (eine .js pro Tool)
├── monitor/
│   └── index.js                — Web-UI (~6000 Zeilen, alle Pages als Template-Strings)
├── caddy/Caddyfile             — Reverse-Proxy + TLS
├── data/                       — Volume: SQLite, Notes, Mail-Sig, system-prompt.txt
└── ios/                        — SwiftUI-App (XcodeGen)
```

### Zentrale Endpunkte (`core/index.js`)
- `POST /api/chat/send/stream` — SSE-Stream (delta/tool_use/tool_result)
- `GET /api/chat/history?chatId=&limit=` — Verlauf
- `GET/PUT /api/settings` — globale Konfig (.env-Editor mit Recreate-Trigger)
- `GET/PUT /api/system-prompt` — Custom-Prompt (Hot-Reload)
- `POST /api/tools/{generate,refine,test,save}` — KI-Tool-Generator
- `GET /api/voice/voices?engine=piper|edge` + `POST /api/voice/synth`

### Container-Operations
```bash
# Restart einzeln
sudo docker compose -f /home/mcde/kiasy/docker-compose.yml restart kiasy-core

# Code-Änderung deployen (NICHT restart, sondern up --build)
sudo docker compose up -d --build kiasy-core kiasy-monitor

# Logs
sudo docker logs -f kiasy-core

# DB inspizieren (vom Host)
sqlite3 /home/mcde/kiasy/data/jarvis.db ".tables"
```

---

## 9. Konventionen (User-Präferenzen Michaels)

Wichtig zu wissen für jede Folge-Session:
- **Sprache**: Deutsch, technische Begriffe englisch.
- **Direkt, kein Geschwätz, keine Höflichkeitsschleifen.**
- **Auskommentieren statt löschen** für Fallback (siehe Pattern in `monitor/index.js` mit `chatBody()`, `notes` etc.).
- **Auto-Commit nach Arbeit**: jede sinnvolle Einheit selbstständig committen + pushen. Commit-Messages auf Deutsch, mit kurzem Why.
- **Testet interaktiv** über Telegram + iOS-App (nicht über Unit-Tests — die existieren nicht, das ist eine bekannte Schuld).

---

## 10. Was diese Session NICHT geklärt hat (offene Strategie-Fragen)

Für die Folge-Session zur Diskussion mit Michael:
- **Geschäftsmodell**: Hardware-Verkauf einmalig vs. Subscription für Software-Updates? White-Label für Reseller (z.B. Systemhäuser)?
- **Zielkunde genauer**: KMU-Geschäftsführer (5-50 MA)? Berater? C-Level in Konzernen? Jede Gruppe hat andere Compliance-/Integrations-Anforderungen.
- **Datenresidenz**: Nur Box (kein Cloud-Touch)? Hybrid (lokale Box + verschlüsselte Cloud-Sync)?
- **Sprache**: Nur DE/EN, oder von Anfang an mehrsprachig?
- **Integrations-Strategie**: M365 (Exchange, SharePoint, Teams)? Google Workspace? Salesforce? Eines davon zuerst?
- **Vertriebsweg**: Direkt? Über IT-Systemhäuser? Über Beratungen die als Reseller fungieren?

Diese Fragen entscheiden viel an der Architektur — z.B. ob die Box wirklich offline-fähig sein muss oder „lokal aber mit zentralem Cloud-Account-Management" reicht.

---

**Stand des Briefings**: 2026-05-09. Repo-Branch `v2`, Commit `f5ce345`.
