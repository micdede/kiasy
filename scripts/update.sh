#!/bin/bash
# ============================================================
# KIASY – Update Script
#
# Aktualisiert eine bestehende Installation auf die neueste
# Version. Führt Code-Update, Dependency-Updates und
# Datenbank-Migrationen automatisch durch.
#
# Nutzung:
#   bash scripts/update.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# --- Farben ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info() { echo -e "  ${CYAN}→${NC} $1"; }
header() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

# --- Prüfungen ---
[ -f ".env" ] || fail ".env nicht gefunden — ist das eine KIASY-Installation?"
[ -f "package.json" ] || fail "package.json nicht gefunden"

# Bot-Name aus .env lesen
BOT_NAME=$(grep '^BOT_NAME=' .env 2>/dev/null | cut -d= -f2)
BOT_NAME="${BOT_NAME:-KIASY}"

echo ""
echo -e "${BOLD}${CYAN}KIASY Update ($BOT_NAME)${NC}"
echo ""

# ============================================================
#  1. Aktuelle Version merken
# ============================================================
OLD_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unbekannt")
info "Aktuelle Version: $OLD_COMMIT"

# ============================================================
#  2. Code aktualisieren
# ============================================================
header "Code aktualisieren"

# Lokale Änderungen prüfen
if ! git diff --quiet HEAD -- 2>/dev/null; then
    warn "Lokale Änderungen erkannt — werden gesichert (git stash)"
    git stash push -m "update-backup-$(date +%Y%m%d-%H%M%S)" --quiet
    STASHED=true
else
    STASHED=false
fi

# Pull
git pull --rebase 2>&1 | while read line; do echo "  $line"; done
NEW_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unbekannt")

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
    ok "Bereits auf dem neuesten Stand ($NEW_COMMIT)"
else
    ok "Aktualisiert: $OLD_COMMIT → $NEW_COMMIT"
fi

# Stash wiederherstellen
if [ "$STASHED" = true ]; then
    if git stash pop --quiet 2>/dev/null; then
        ok "Lokale Änderungen wiederhergestellt"
    else
        warn "Lokale Änderungen konnten nicht automatisch wiederhergestellt werden"
        warn "Nutze 'git stash pop' um sie manuell wiederherzustellen"
    fi
fi

# ============================================================
#  3. NPM Dependencies
# ============================================================
header "Dependencies"

npm install --production 2>&1 | tail -1
ok "NPM Packages aktualisiert"

# ============================================================
#  4. Python venv (falls vorhanden)
# ============================================================
if [ -d "venv" ]; then
    header "Python Packages"
    source venv/bin/activate 2>/dev/null
    pip install --quiet --upgrade edge-tts openai-whisper 2>/dev/null
    deactivate 2>/dev/null
    ok "edge-tts + whisper aktualisiert"
fi

# ============================================================
#  5. Datenbank-Migrationen
# ============================================================
header "Datenbank"

DB_FILE="$PROJECT_DIR/jarvis.db"

if [ -f "$DB_FILE" ]; then
    # Migrationen: Neue Tabellen/Spalten hinzufügen
    # SQLite ignoriert "IF NOT EXISTS" — sicher für wiederholtes Ausführen
    sqlite3 "$DB_FILE" <<'SQLEOF'
-- FTS5 für Messages (falls noch nicht vorhanden)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, text_preview, content=messages, content_rowid=id
);

-- FTS5 für Knowledge Base
CREATE VIRTUAL TABLE IF NOT EXISTS kb_notes_fts USING fts5(
    title, tags, body, content=kb_notes
);

-- FTS5 für Memory
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    key, value, content=memory, content_rowid=id
);

-- Workflows (falls noch nicht vorhanden)
CREATE TABLE IF NOT EXISTS workflows (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    status       TEXT DEFAULT 'running',
    chat_id      TEXT,
    context      TEXT DEFAULT '{}',
    created      TEXT DEFAULT (datetime('now','localtime')),
    updated      TEXT DEFAULT (datetime('now','localtime')),
    current_step INTEGER DEFAULT 0,
    error        TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id   TEXT NOT NULL,
    step_num      INTEGER NOT NULL,
    action        TEXT NOT NULL,
    status        TEXT DEFAULT 'pending',
    scheduled     TEXT,
    delay_minutes INTEGER,
    condition     TEXT,
    result        TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

-- Tool Settings (falls noch nicht vorhanden)
CREATE TABLE IF NOT EXISTS tool_settings (
    filename TEXT PRIMARY KEY,
    enabled  INTEGER DEFAULT 1,
    updated  TEXT DEFAULT (datetime('now','localtime'))
);

-- Roadmap (falls noch nicht vorhanden)
CREATE TABLE IF NOT EXISTS roadmap (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT DEFAULT 'idea',
    priority    TEXT DEFAULT 'normal',
    category    TEXT DEFAULT '',
    created     TEXT DEFAULT (datetime('now','localtime')),
    updated     TEXT DEFAULT (datetime('now','localtime'))
);

-- Terminal (falls noch nicht vorhanden)
CREATE TABLE IF NOT EXISTS terminal_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS terminal_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
SQLEOF

    ok "Datenbank-Migrationen ausgeführt"
else
    info "Keine Datenbank gefunden — wird beim ersten Start erstellt"
fi

# ============================================================
#  6. Service-Datei aktualisieren
# ============================================================
header "Service-Konfiguration"

SERVICE_FILE="/etc/systemd/system/kiasy.service"
if [ -f "$SERVICE_FILE" ]; then
    # Restart=on-failure → Restart=always (damit Neustarts aus dem Monitor funktionieren)
    if grep -q "Restart=on-failure" "$SERVICE_FILE" 2>/dev/null; then
        sudo sed -i 's/Restart=on-failure/Restart=always/' "$SERVICE_FILE"
        sudo sed -i 's/RestartSec=10/RestartSec=5/' "$SERVICE_FILE"
        sudo systemctl daemon-reload
        ok "Service-Datei aktualisiert (Restart=always)"
    else
        ok "Service-Datei bereits aktuell"
    fi
else
    info "Keine Service-Datei gefunden"
fi

# ============================================================
#  7. Neue .env-Variablen prüfen
# ============================================================
header "Konfiguration prüfen"

MISSING=0
check_env() {
    local key="$1"
    local desc="$2"
    if ! grep -q "^${key}=" .env 2>/dev/null; then
        warn "Neue Variable: ${BOLD}${key}${NC} — $desc"
        MISSING=$((MISSING + 1))
    fi
}

check_env "OWNER_NAME" "Dein Name (z.B. Michael)"
check_env "OWNER_CITY" "Deine Stadt (z.B. Berlin) — für Wetter"
check_env "BOT_NAME" "Name des Bots (z.B. JARVIS)"
check_env "BOT_LANG" "Sprache: de oder en"
check_env "TZ" "Zeitzone (z.B. Europe/Berlin)"

if [ "$MISSING" -gt 0 ]; then
    echo ""
    warn "$MISSING neue Variable(n) — bitte in .env ergänzen"
    info "Siehe .env.example für Beschreibungen"
else
    ok "Alle Variablen vorhanden"
fi

# ============================================================
#  8. Service neustarten
# ============================================================
header "Service"

service_name="kiasy"

if systemctl is-active --quiet "$service_name" 2>/dev/null; then
    sudo systemctl restart "$service_name"
    sleep 2
    if systemctl is-active --quiet "$service_name" 2>/dev/null; then
        ok "$service_name neu gestartet"
    else
        fail "$service_name konnte nicht gestartet werden — prüfe: journalctl -u $service_name -n 20"
    fi
elif systemctl list-unit-files | grep -q "$service_name" 2>/dev/null; then
    info "$service_name ist gestoppt — starte mit: sudo systemctl start $service_name"
else
    info "Kein systemd Service gefunden — starte manuell: node telegram.js"
fi

# ============================================================
#  Zusammenfassung
# ============================================================
echo ""
echo -e "${GREEN}  ══════════════════════════════════════════${NC}"
echo -e "  ${BOLD}Update abgeschlossen!${NC}"
echo -e "${GREEN}  ══════════════════════════════════════════${NC}"
echo ""
echo -e "  Version: ${BOLD}$NEW_COMMIT${NC}"
[ "$MISSING" -gt 0 ] && echo -e "  ${YELLOW}!${NC} $MISSING neue .env-Variable(n) ergänzen"
echo ""

# Changelog seit letztem Update anzeigen
if [ "$OLD_COMMIT" != "$NEW_COMMIT" ]; then
    echo -e "  ${BOLD}Änderungen:${NC}"
    git log --oneline "${OLD_COMMIT}..${NEW_COMMIT}" 2>/dev/null | while read line; do
        echo "    • $line"
    done
    echo ""
fi
