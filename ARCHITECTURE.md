# kiasy v2 — Architektur

> Stand-alone, container-basierter Neuaufbau von JARVIS.
> Branch: `v2` · Pfad: `/home/mcde/kiasy/` · Repo: `kiasy`
> Bot-Persona bleibt **JARVIS**, Codebase + Projektname: **kiasy**

---

## 1. Designprinzipien

1. **Stand-alone** — alle benötigten Services laufen auf dem JARVIS-Mini-PC. Keine externen LAN-Maschinen mehr (Unraid kann weg).
2. **Container-Stack** — alles per `docker compose`. Restart, Logs, Volumes, Backup zentral.
3. **API + URL austauschbar** — Whisper, Piper, Ollama wahlweise lokal oder remote per ENV.
4. **Mehrere Clients** — Telegram (heute), Mac-App (heute), zukünftig eigene Dialog-App. Server stellt eine konsistente API bereit.
5. **Erreichbarkeit** — nur via vorhandenes Router-VPN; Telegram outbound (Long-Polling).
6. **KISS** — SQLite bleibt, keine Build-Pipeline für UI (HTMX + server-rendered).

---

## 2. Stack-Übersicht

```
┌─────────────────────────────────────────────────────────────┐
│  Router (LAN + VPN)                                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
               ┌───────▼────────┐
               │ caddy (TLS)    │  443 (intern, VPN-only)
               └───────┬────────┘
                       │
   ┌───────────────────┼─────────────────────┐
   │                   │                     │
┌──▼──────┐  ┌─────────▼─────────┐  ┌────────▼────────┐
│ kiasy-  │  │ kiasy-monitor     │  │ kiasy-core      │
│ static  │  │ (HTMX + Express)  │  │ (Agent, Tools,  │
│ (assets)│  │                   │  │  Telegram, Mail)│
└─────────┘  └─────────┬─────────┘  └────┬────────────┘
                       │                  │
                       └──────┬───────────┘
                              │
        ┌────────────┬────────┼────────┬────────┬────────┐
        │            │        │        │        │        │
   ┌────▼──┐    ┌────▼──┐ ┌───▼───┐ ┌──▼───┐ ┌──▼───┐ ┌─▼────┐
   │qdrant │    │ollama │ │whisper│ │piper │ │searx │ │ ...  │
   │       │    │(cloud │ │       │ │      │ │ng    │ │      │
   │       │    │ proxy)│ │       │ │      │ │      │ │      │
   └───────┘    └───────┘ └───────┘ └──────┘ └──────┘ └──────┘

  + jarvis.db (SQLite, Volume)   + Backup-Cron (host-side)
```

---

## 3. Container

| Container | Image | Zweck | Ports (intern) | Volume(s) |
|-----------|-------|-------|---------------|-----------|
| **kiasy-core** | custom (`Dockerfile.core`) — Node.js 24 | Agent-Loop, Tool-Execution, Telegram-Bot, Mail-Watcher, Scheduler | 8080 (API), 8081 (SSE/WebSocket) | `./data:/data` (DB, secrets), `./notes:/data/notes`, `./certs:/certs` |
| **kiasy-monitor** | custom (`Dockerfile.monitor`) — Node.js 24 | Monitor-Web-UI (HTMX + Express, server-rendered Templates) | 3000 | mount nur Public-Assets |
| **caddy** | `caddy:2-alpine` | Reverse-Proxy + TLS (LAN-internal, self-signed via internal CA) | 443 | `./caddy/Caddyfile`, `./caddy/data` |
| **ollama** | `ollama/ollama:latest` | Cloud-Proxy für `:cloud`-Modelle, optional kleine lokale Modelle | 11434 | `ollama-models` |
| **whisper** | `linuxserver/faster-whisper` o.ä. | STT API (lokal CPU, model: medium) | 9000 | `whisper-models` |
| **piper** | `rhasspy/wyoming-piper` | TTS (Wyoming-Protocol) | 10200 | `piper-voices` |
| **qdrant** | `qdrant/qdrant:latest` | Vektor-Memory | 6333 | `qdrant-data` |
| **searxng** | `searxng/searxng:latest` | Metasuche | 8080 (intern remap) | `searxng-config` |

**Optional / Phase 2:**
- `wakeword` — openWakeWord-Service für Mac-App-Wake-on-Voice
- `loki + promtail` — zentrale Log-Aggregation

---

## 4. Netzwerk & Ports

- Single internal Docker-Network `kiasy-net` (alle Container reden via Container-DNS: `http://ollama:11434`, `http://qdrant:6333` etc.)
- **Nur 1 exposed Port nach außen:** `caddy:443` → erreichbar im LAN (über VPN von außen)
- Alle anderen Container haben keinen Port-Mapping zum Host — Kommunikation läuft intern
- Telegram + Mail: outbound vom `kiasy-core`, kein Inbound nötig

---

## 5. Volumes & Persistenz

| Volume | Inhalt | Backup-relevant |
|--------|--------|-----------------|
| `./data/jarvis.db` | SQLite (Messages, Memory, Reminders, KB-Index, Workflows, Settings) | **JA** |
| `./data/.env` | Secrets (Telegram-Token, Anthropic-Key, Kerio-Pass, etc.) | **JA** |
| `./notes/` | KB-Markdown (Source of Truth, Git-Sync) | **JA** (auch Git) |
| `./certs/` | Self-signed CA + Server-Cert | **JA** |
| `qdrant-data` | Vektor-Collection `jarvis_memory` | **JA** (Snapshot-API) |
| `ollama-models` | LLM-Modelle (Cloud-Auth + ggf. lokale Modelle) | nein (regenerierbar) |
| `whisper-models` | faster-whisper-Modelle | nein (regenerierbar) |
| `piper-voices` | Piper-Voice-Models (.onnx + .json) | nein (regenerierbar via Init-Script) |
| `searxng-config` | SearXNG settings.yml | klein, in Repo committen |
| `caddy/data` | TLS-Zustand + interne CA | **JA** |

---

## 6. Tools (final, ~17)

Speicherort: `kiasy-core` Container, Pfad `tools/` im Image.

| Tool | Zweck | Ext. Deps |
|------|-------|-----------|
| `memory` | Persistentes Gedächtnis (facts/todos/notes) | DB |
| `reminder` | Erinnerungen + Wiederholungen | DB, Telegram |
| `knowledge` | Wissensbasis CRUD + FTS | DB, notes/, Git |
| `chat-history` | Verlauf durchsuchen | DB |
| `homeassistant` | HA Get/Toggle/Service/History | HA-URL+Token |
| `workflow` | Mehrstufige Agentic Loops | DB |
| `web-browse` | Web-Seiten lesen + Link-Extraktion | – |
| `search` | Web-Suche (SearXNG-Wrapper) | searxng-Container |
| `shell` | Shell-Befehle | – |
| `files` | Dateisystem-Ops | – |
| `telegram-send` | Telegram-Nachrichten versenden | TG-Token |
| `image` | Bilder versenden + generieren | OPENAI_KEY (DALL-E) |
| `mail` | **NEU konsolidiert** — IMAP+SMTP, Kerio als Backend konfigurierbar | KERIO_*  |
| `calendar` | **NEU konsolidiert** — CalDAV (Kerio + iCloud + Nextcloud) | CalDAV-URL |
| `weather` | **NEU konsolidiert** — Open-Meteo (kein Key) | – |
| `news` | RSS + News-APIs (DB-driven Sources) | NEWS_API_KEY (opt) |
| `documents` | PDF/Word/Excel generieren | – |
| `delegation` | **verbessert** — Aufgabendelegation + Followup | DB, Mail |

**Gestrichen vs. heute:** btc-price, recipe, feiertage, hardware, community, ollama-llm, kerio-api, kerio-config, kerio-contacts, kerio-notes, kerio-tasks, caldav (in calendar gemerged), openmeteo (in weather gemerged)

---

## 7. Monitor-Pages

`kiasy-monitor` Container, Stack: **HTMX + Express + Server-rendered Templates**, **ein modernes Default-Theme** (kein Editor mehr).

| Page | Zweck |
|------|-------|
| `/` | Dashboard (System-Status, letzte Events, Health) |
| `/chat` | Chat-UI (PWA-fähig) |
| `/notes` | Wissensbasis-Editor |
| `/reminders` | Erinnerungen-Kalender |
| `/memory` | Gedächtnis-Verwaltung + semantische Suche |
| `/tools` | Tool-Manager (Enable/Disable, Upload) |
| `/workflows` | Workflow-Builder + Status |
| `/news` | News-Quellen-Config |
| `/delegations` | Delegations-Tracking + Followup |
| `/ha-editor` | Home-Assistant YAML-Editor |
| `/voice` | **NEU** — TTS/STT-Tests, Stimmen-Wahl, Latenz-Messung, Wake-Word-Setup |
| `/health` | **NEU** — Status aller Container (Ollama, Whisper, Piper, Qdrant, Caddy) |
| `/backup` | **NEU** — Letzte Backups, manueller Trigger, Restore-Helper |
| `/labs` | **NEU statt /roadmap** — Ideen-Inbox, Tool-Drafts, Experimente |
| `/settings` | Auth, Theme-Akzentfarbe, ENV-relevante Toggles |

**Gestrichen:** `/terminal`, `/community`, `/theme-editor`, `/system` (in `/` integriert), `/roadmap` (→ `/labs`)

---

## 8. DB-Schema (10 Tabellen)

| Tabelle | Zweck |
|---------|-------|
| `messages` | Chat-Verlauf (FTS5) |
| `memory` | Gedächtnis (facts/todos/notes, FTS5) |
| `reminders` | Erinnerungen + Recurring + Fail-Count |
| `kb_notes` | Wissensbasis-Index (FTS5, Files in `notes/`) |
| `events` | Monitor-Events (30-Tage-Cleanup) |
| `workflows` | Agentic Workflows |
| `workflow_steps` | Steps + Conditions |
| `tool_settings` | Tool Enable/Disable + Visibility |
| `news_sources` | News-Quellen (API + RSS) |
| `delegations` (+ `delegation_tasks`) | Delegations + Sub-Tasks |
| `labs_items` | **NEU** — Ideen, Drafts, Experimente |
| `migrations` | **NEU** — Migration-Tracking (numerierte SQL-Files) |

**Migrations-Ordner:** `db/migrations/001_init.sql` … `NNN_xxx.sql`. `kiasy-core` führt beim Start aus, was noch nicht in `migrations` steht.

---

## 9. Auth & Sicherheit

- **Erreichbarkeit:** ausschließlich LAN + Router-VPN — kein Inbound-Port öffentlich.
- **Web-UI:** Basic Auth (Monitor-User/Pass aus `.env`) + Rate-Limit auf Login.
- **API für Mac-App / Echtdialog-App:** Token-basiert (langlebige Tokens, manuell in `/settings` erstellt + revokebar).
- **TLS:** Caddy mit interner CA — Mac-App und Browser akzeptieren via TrustingDelegate / Cert-Import.
- **Telegram:** Whitelist `TELEGRAM_ALLOWED_USERS` — bleibt wie heute.

---

## 10. Backup

- `scripts/backup.sh` (aus v1 portiert, an Container angepasst):
  - SQLite WAL-Checkpoint via `docker exec kiasy-core node -e "..."`
  - Qdrant Snapshot via interne API
  - Tar mit `data/`, `notes/`, `certs/`, `caddy/data`, Qdrant-Snapshot, Manifest
- Cron auf Host: täglich 03:00, hält letzte 14 lokal
- Optional `BACKUP_REMOTE=user@nas:/backup/` per scp wegschieben
- `scripts/restore-from-backup.sh` rekonstruiert kompletten Stack

---

## 11. Migration vom Alt-System

**Phase 0 — Setup (heute):**
1. v2-Branch im `kiasy`-Repo
2. Worktree unter `/home/mcde/kiasy/`
3. Dieses ARCHITECTURE.md als ersten Commit

**Phase 1 — Skelett (~2-3h):**
4. `docker-compose.yml` mit allen Containern (Default-Configs)
5. `Dockerfile.core` + `Dockerfile.monitor` minimal
6. Caddyfile mit interner CA
7. Smoke-Test: alle Container UP, alle Health-Endpoints grün

**Phase 2 — Daten-Migration (~30min):**
8. Backup vom Alt-System ziehen (`scripts/backup.sh`)
9. Per `restore-from-backup.sh` State in V2-Volumes spielen (DB, notes, qdrant)

**Phase 3 — Code-Port (~mehrere Sessions):**
10. `lib/db.js` mit Migrations-System portieren
11. Tools nach finaler Liste portieren (konsolidieren wo nötig)
12. `kiasy-core`: Agent, Telegram, Mail-Watcher, Scheduler
13. `kiasy-monitor`: erstmal ein modernes Theme + Layout, dann Pages portieren

**Phase 4 — Cutover:**
14. Alt-System (`whatsapp-claude` + `jarvis-telegram.service`) stoppen
15. V2 startet — gleiche Telegram-Bot-Identität, gleiche DB-Inhalte
16. Alt-System bleibt erstmal liegen (Rollback-Option) → nach 2 Wochen löschen

---

## 12. Offene Punkte / TBD

- **Whisper-Image:** `linuxserver/faster-whisper` vs. `onerahmet/openai-whisper-asr-webservice` vs. eigenes — bei Setup entscheiden
- **Piper-Image:** `rhasspy/wyoming-piper` (proven, was wir auf Unraid hatten) → Default
- **Caddy interne CA:** Standard `local_certs` reicht für LAN — Mac-App-Cert-Trust erbt unsere TrustingDelegate-Logik
- **Echtdialog-App-API:** WebSocket-Endpoint mit Barge-In — Spec wird in Phase 3 ausgearbeitet
- **Wake-Word:** noch keine Festlegung — Phase 2 Add-On nach Bedarf
- **Cost-Control:** Token-Budget pro Tag → in `/settings` exposed (Phase 3)
- **Monitor-Default-Theme:** modern, dunkel, Akzentfarbe konfigurierbar — visuell entwerfen sobald Skelett steht
