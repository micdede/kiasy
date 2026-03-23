#!/bin/bash
# ============================================================
# JARVIS Migration Script
# Kopiert JARVIS vom alten Server auf den neuen
# Ausführen auf dem ALTEN Server: bash scripts/migrate.sh
# ============================================================

set -e

NEW_HOST="mcde@192.168.178.144"
PROJECT_DIR="/home/mcde/whatsapp-claude"
REMOTE_DIR="/home/mcde/whatsapp-claude"

echo "========================================"
echo "  JARVIS Migration"
echo "  Ziel: $NEW_HOST"
echo "========================================"
echo ""

# --- 1. SSH-Verbindung testen ---
echo "[1/7] SSH-Verbindung testen..."
ssh -o ConnectTimeout=5 $NEW_HOST "echo 'SSH OK'" || { echo "FEHLER: SSH-Verbindung fehlgeschlagen"; exit 1; }
echo ""

# --- 2. Node.js + Build-Tools auf neuem Server installieren ---
echo "[2/7] Node.js + Abhängigkeiten auf neuem Server installieren..."
ssh $NEW_HOST 'bash -s' << 'REMOTE_SETUP'
set -e

# Node.js prüfen / installieren
if command -v node &>/dev/null; then
  echo "  Node.js bereits installiert: $(node -v)"
else
  echo "  Node.js installieren..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "  Node.js installiert: $(node -v)"
fi

# Build-Tools für native Module (better-sqlite3)
if ! dpkg -l build-essential &>/dev/null 2>&1; then
  echo "  Build-Tools installieren..."
  sudo apt-get update -qq
  sudo apt-get install -y build-essential python3 make g++
else
  echo "  Build-Tools bereits vorhanden"
fi

# ffmpeg für Whisper/TTS
if ! command -v ffmpeg &>/dev/null; then
  echo "  ffmpeg installieren..."
  sudo apt-get install -y ffmpeg
else
  echo "  ffmpeg bereits vorhanden"
fi

echo "  Setup abgeschlossen"
REMOTE_SETUP
echo ""

# --- 3. Projektdateien synchronisieren ---
echo "[3/7] Projektdateien synchronisieren..."
rsync -avz --progress \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude 'temp/' \
  --exclude 'venv/' \
  --exclude 'logs/' \
  --exclude 'chat-history.db*' \
  --exclude 'jarvis.db*' \
  --exclude '.last-telegram-chat' \
  --exclude '.wwebjs_auth/' \
  --exclude '.wwebjs_cache/' \
  "$PROJECT_DIR/" "$NEW_HOST:$REMOTE_DIR/"
echo ""

# --- 4. Sensible Dateien separat kopieren ---
echo "[4/7] Konfiguration + Datenbanken kopieren..."

# .env
if [ -f "$PROJECT_DIR/.env" ]; then
  scp "$PROJECT_DIR/.env" "$NEW_HOST:$REMOTE_DIR/.env"
  echo "  .env kopiert"
fi

# jarvis.db (Hauptdatenbank)
if [ -f "$PROJECT_DIR/jarvis.db" ]; then
  scp "$PROJECT_DIR/jarvis.db" "$NEW_HOST:$REMOTE_DIR/jarvis.db"
  echo "  jarvis.db kopiert"
fi

# SSL-Zertifikate
if [ -d "$PROJECT_DIR/certs" ]; then
  rsync -avz "$PROJECT_DIR/certs/" "$NEW_HOST:$REMOTE_DIR/certs/"
  echo "  Zertifikate kopiert"
fi

# Wissensbasis
if [ -d "$PROJECT_DIR/notes" ]; then
  rsync -avz "$PROJECT_DIR/notes/" "$NEW_HOST:$REMOTE_DIR/notes/"
  echo "  Wissensbasis kopiert"
fi

# Memory (Backup, DB ist primär)
if [ -f "$PROJECT_DIR/memory.json" ]; then
  scp "$PROJECT_DIR/memory.json" "$NEW_HOST:$REMOTE_DIR/memory.json"
  echo "  memory.json kopiert (Backup)"
fi

# Reminders (Backup, DB ist primär)
if [ -f "$PROJECT_DIR/reminders.json" ]; then
  scp "$PROJECT_DIR/reminders.json" "$NEW_HOST:$REMOTE_DIR/reminders.json"
  echo "  reminders.json kopiert (Backup)"
fi
echo ""

# --- 5. npm install auf neuem Server ---
echo "[5/7] npm install auf neuem Server..."
ssh $NEW_HOST "cd $REMOTE_DIR && npm install --production 2>&1 | tail -5"
echo ""

# --- 6. Python venv für Whisper + Edge-TTS ---
echo "[6/7] Python venv für Whisper + Edge-TTS einrichten..."
ssh $NEW_HOST 'bash -s' << 'REMOTE_PYTHON'
set -e
cd /home/mcde/whatsapp-claude

# Python venv prüfen
if ! command -v python3 &>/dev/null; then
  echo "  Python3 installieren..."
  sudo apt-get install -y python3 python3-venv python3-pip
fi

if [ ! -d "venv" ]; then
  echo "  Python venv erstellen..."
  python3 -m venv venv
fi

echo "  Whisper + Edge-TTS installieren..."
venv/bin/pip install -q openai-whisper edge-tts 2>&1 | tail -3
echo "  Python-Tools installiert"
REMOTE_PYTHON
echo ""

# --- 7. systemd-Service einrichten ---
echo "[7/7] systemd-Service einrichten..."
ssh $NEW_HOST 'bash -s' << 'REMOTE_SERVICE'
set -e

SERVICE_FILE="/etc/systemd/system/jarvis-telegram.service"
if [ ! -f "$SERVICE_FILE" ]; then
  echo "  Service-Datei erstellen..."
  sudo tee $SERVICE_FILE > /dev/null << 'EOF'
[Unit]
Description=JARVIS Telegram Bot
After=network.target

[Service]
Type=simple
User=mcde
WorkingDirectory=/home/mcde/whatsapp-claude
ExecStart=/usr/bin/node telegram.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable jarvis-telegram
  echo "  Service installiert und aktiviert"
else
  echo "  Service existiert bereits"
fi

echo ""
echo "  Service NICHT gestartet (manuell starten wenn bereit):"
echo "  sudo systemctl start jarvis-telegram"
REMOTE_SERVICE

echo ""
echo "========================================"
echo "  Migration abgeschlossen!"
echo "========================================"
echo ""
echo "  Nächste Schritte:"
echo "  1. SSH auf neuen Server: ssh $NEW_HOST"
echo "  2. .env prüfen: nano $REMOTE_DIR/.env"
echo "  3. JARVIS starten: sudo systemctl start jarvis-telegram"
echo "  4. Logs prüfen: journalctl -u jarvis-telegram -f"
echo "  5. Monitor testen: https://192.168.178.144:3333/"
echo ""
echo "  Wenn alles läuft:"
echo "  - Alten Server stoppen: sudo systemctl stop jarvis-telegram"
echo "  - IP tauschen: .50 auf neuen Server"
echo "  - .env anpassen falls nötig"
echo ""
