#!/bin/bash
# ============================================================
# JARVIS – Wiederherstellungsscript
#
# Stellt JARVIS auf einem frischen Ubuntu-System wieder her.
# Voraussetzung: Ubuntu 22.04+ / Debian 12+, sudo-Rechte
#
# Nutzung:
#   1. git clone git@github.com:micdede/jarvisBackup.git whatsapp-claude
#   2. cd whatsapp-claude
#   3. bash scripts/restore.sh
#   4. .env anpassen (cp .env.example .env && nano .env)
#   5. sudo systemctl start jarvis-telegram
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "============================================"
echo "  JARVIS Wiederherstellung"
echo "============================================"
echo ""
echo "Projektverzeichnis: $PROJECT_DIR"
echo ""

# --- Farben ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[FEHLER]${NC} $1"; }

# --- 1. System-Pakete ---
echo "--- Schritt 1/7: System-Pakete ---"
sudo apt update -qq
sudo apt install -y -qq curl git ffmpeg openssl python3 python3-venv 2>/dev/null
ok "System-Pakete installiert"

# --- 2. Node.js (v24 via NodeSource) ---
echo ""
echo "--- Schritt 2/7: Node.js ---"
if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    ok "Node.js bereits installiert: $NODE_VER"
else
    echo "Installiere Node.js v24..."
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y -qq nodejs
    ok "Node.js $(node --version) installiert"
fi

# --- 3. NPM Dependencies ---
echo ""
echo "--- Schritt 3/7: NPM Packages ---"
npm install --production 2>/dev/null
ok "NPM Packages installiert"

# --- 4. Python venv (Whisper + Edge-TTS) ---
echo ""
echo "--- Schritt 4/7: Python venv (Whisper + Edge-TTS) ---"
if [ ! -d "venv" ]; then
    python3 -m venv venv
    ok "Python venv erstellt"
else
    ok "Python venv existiert bereits"
fi

source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet edge-tts openai-whisper
deactivate
ok "edge-tts + whisper installiert"

# --- 5. Verzeichnisse + SSL-Zertifikate ---
echo ""
echo "--- Schritt 5/7: Verzeichnisse + Zertifikate ---"
mkdir -p temp logs notes certs tools scripts lib

if [ ! -f "certs/cert.pem" ]; then
    echo "Erstelle selbst-signierte SSL-Zertifikate für Monitor..."
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout certs/key.pem -out certs/cert.pem \
        -days 3650 -subj "/CN=jarvis/O=JARVIS/C=DE" 2>/dev/null
    ok "SSL-Zertifikate erstellt (certs/)"
else
    ok "SSL-Zertifikate vorhanden"
fi

# --- 6. .env ---
echo ""
echo "--- Schritt 6/7: Konfiguration ---"
if [ ! -f ".env" ]; then
    cp .env.example .env
    warn ".env aus .env.example erstellt — MUSS noch angepasst werden!"
    warn "  nano $PROJECT_DIR/.env"
else
    ok ".env existiert bereits"
fi

# Leere JSON-Dateien anlegen falls nicht vorhanden
[ -f "memory.json" ]      || echo '{"facts":[],"todos":[],"notes":[]}' > memory.json
[ -f "reminders.json" ]   || echo '[]' > reminders.json
ok "Datendateien vorhanden"

# --- 7. Systemd Service ---
echo ""
echo "--- Schritt 7/7: Systemd Service ---"
SERVICE_FILE="/etc/systemd/system/jarvis-telegram.service"
if [ -f "$SERVICE_FILE" ]; then
    ok "Service existiert bereits"
else
    echo "Erstelle systemd Service..."
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=JARVIS Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/node telegram.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jarvis-telegram

Environment=HOME=$HOME TZ=Europe/Berlin

# Sicherheits-Einstellungen
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$PROJECT_DIR $HOME/.cache /tmp

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable jarvis-telegram
    ok "Service erstellt und aktiviert"
fi

# --- SSH Key für Git ---
echo ""
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
    warn "Kein SSH-Key gefunden. Für Git-Backup erstellen:"
    warn "  ssh-keygen -t ed25519 -C \"jarvis@server\""
    warn "  Public Key als Deploy Key auf GitHub hinzufügen"
else
    ok "SSH-Key vorhanden"
fi

# --- Notes Git Repo ---
if [ ! -d "notes/.git" ]; then
    warn "notes/ ist kein Git-Repo. Für Wissensbasis-Backup:"
    warn "  cd notes && git init && git config user.name 'JARVIS' && git config user.email 'jarvis@server'"
    warn "  git remote add origin git@github.com:micdede/jarvis.git"
    warn "  git commit --allow-empty -m 'init' && git push -u origin main"
else
    ok "notes/ Git-Repo vorhanden"
fi

# --- Zusammenfassung ---
echo ""
echo "============================================"
echo "  Wiederherstellung abgeschlossen!"
echo "============================================"
echo ""
echo "Nächste Schritte:"
echo ""
if [ ! -s ".env" ] || grep -q "DEIN_BOT_TOKEN" .env 2>/dev/null; then
    echo "  1. .env konfigurieren:"
    echo "     nano $PROJECT_DIR/.env"
    echo ""
    echo "     Mindestens setzen:"
    echo "     - TELEGRAM_TOKEN (von @BotFather)"
    echo "     - LLM_PROVIDER + zugehörige Keys"
    echo "     - MONITOR_USER / MONITOR_PASS"
    echo ""
fi
echo "  2. Service starten:"
echo "     sudo systemctl start jarvis-telegram"
echo ""
echo "  3. Prüfen:"
echo "     sudo journalctl -u jarvis-telegram -f"
echo ""
echo "  4. Monitor öffnen:"
echo "     https://<server-ip>:3333"
echo ""
echo "============================================"
echo "  Infrastruktur-Übersicht"
echo "============================================"
echo ""
echo "  Unraid Server:   192.168.178.20"
echo "    - Ollama:      :11434 (LLM)"
echo "    - SearXNG:     :8888 (Websuche)"
echo "  Home Assistant:  192.168.178.8:8123"
echo "  Kerio Mail:      wrsk-mail.de"
echo "  Monitor:         https://<server-ip>:3333"
echo ""
