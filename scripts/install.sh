#!/bin/bash
# ============================================================
# Interaktives Installationsscript
#
# Richtet einen persönlichen KI-Assistenten auf einem frischen
# Ubuntu/Debian-System ein. Fragt alle Einstellungen interaktiv ab.
#
# Voraussetzung: Ubuntu 22.04+ / Debian 12+, sudo-Rechte
#
# Nutzung:
#   1. Repository klonen
#   2. cd <projektverzeichnis>
#   3. bash scripts/install.sh
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

# ============================================================
#  1. Willkommen + Bot-Name
# ============================================================
clear
echo -e "${CYAN}"
cat << 'LOGO'

       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝

  Persoenlicher KI-Assistent — Interaktive Installation

LOGO
echo -e "${NC}"

echo -e "${BOLD}Willkommen!${NC} Dieses Script richtet deinen persönlichen"
echo -e "KI-Assistenten ein. Du wirst Schritt für Schritt durch"
echo -e "die Konfiguration geführt.\n"

read -p "Wie soll dein Bot heißen? [JARVIS]: " bot_name
bot_name="${bot_name:-JARVIS}"
bot_name_lower=$(echo "$bot_name" | tr '[:upper:]' '[:lower:]')
bot_name_upper=$(echo "$bot_name" | tr '[:lower:]' '[:upper:]')

echo ""
read -p "Wie heißt du (Vorname)? [$(whoami)]: " owner_name
owner_name="${owner_name:-$(whoami)}"

echo ""
read -p "In welcher Stadt wohnst du? (für Wetter, lokale Infos) [Berlin]: " owner_city
owner_city="${owner_city:-Berlin}"

echo ""
# Zeitzone erkennen
detected_tz=$(timedatectl show --value -p Timezone 2>/dev/null || echo "Europe/Berlin")
read -p "Zeitzone? [$detected_tz]: " timezone
timezone="${timezone:-$detected_tz}"

echo ""
# Sprache
echo "  In welcher Sprache soll der Bot antworten?"
echo ""
echo -e "  ${BOLD}[1]${NC} Deutsch"
echo -e "  ${BOLD}[2]${NC} English"
echo ""
read -p "  Auswahl [1]: " lang_choice
lang_choice="${lang_choice:-1}"
case "$lang_choice" in
    2) bot_lang="en" ;;
    *) bot_lang="de" ;;
esac

echo ""
ok "Bot-Name: ${BOLD}$bot_name${NC}"
ok "Besitzer: ${BOLD}$owner_name${NC}"
ok "Stadt:    ${BOLD}$owner_city${NC}"
ok "Zeitzone: ${BOLD}$timezone${NC}"
ok "Sprache:  ${BOLD}$([ "$bot_lang" = "de" ] && echo "Deutsch" || echo "English")${NC}"

# ============================================================
#  2. LLM-Provider
# ============================================================
header "LLM-Provider (Pflicht)"

echo "  Welchen LLM-Provider möchtest du nutzen?"
echo ""
echo -e "  ${BOLD}[1]${NC} Anthropic (Claude)  ${GREEN}← empfohlen${NC}"
echo -e "  ${BOLD}[2]${NC} Ollama (lokal/selbst gehostet)"
echo -e "  ${BOLD}[3]${NC} Groq (kostenlos, schnell)"
echo -e "  ${BOLD}[4]${NC} OpenAI (GPT)"
echo ""

while true; do
    read -p "  Auswahl [1]: " llm_choice
    llm_choice="${llm_choice:-1}"
    case "$llm_choice" in
        1|2|3|4) break ;;
        *) echo -e "  ${RED}Bitte 1-4 wählen.${NC}" ;;
    esac
done

# LLM-spezifische Variablen
llm_provider=""
anthropic_key=""
claude_model=""
ollama_url=""
ollama_model=""
groq_key=""
groq_model=""
openai_key_llm=""
openai_model=""

case "$llm_choice" in
    1)
        llm_provider="anthropic"
        echo ""
        echo -e "  ${CYAN}→ Account erstellen: https://console.anthropic.com${NC}"
        echo -e "  ${CYAN}→ API-Key holen:     https://console.anthropic.com/settings/keys${NC}"
        echo ""
        read -p "  Anthropic API-Key (sk-ant-...): " anthropic_key
        [ -z "$anthropic_key" ] && fail "API-Key ist erforderlich!"
        read -p "  Modell [claude-sonnet-4-20250514]: " claude_model
        claude_model="${claude_model:-claude-sonnet-4-20250514}"
        ;;
    2)
        llm_provider="ollama"
        echo ""
        echo -e "  ${CYAN}→ Ollama installieren: https://ollama.com/download${NC}"
        echo -e "  ${CYAN}→ Dann: ollama pull llama3.1${NC}"
        echo ""
        read -p "  Ollama Base-URL [http://localhost:11434/v1]: " ollama_url
        ollama_url="${ollama_url:-http://localhost:11434/v1}"
        read -p "  Modell [llama3.1]: " ollama_model
        ollama_model="${ollama_model:-llama3.1}"
        ;;
    3)
        llm_provider="groq"
        echo ""
        echo -e "  ${CYAN}→ Account erstellen: https://console.groq.com${NC}"
        echo -e "  ${CYAN}→ API-Key holen:     https://console.groq.com/keys${NC}"
        echo ""
        read -p "  Groq API-Key (gsk_...): " groq_key
        [ -z "$groq_key" ] && fail "API-Key ist erforderlich!"
        read -p "  Modell [llama-3.1-70b-versatile]: " groq_model
        groq_model="${groq_model:-llama-3.1-70b-versatile}"
        ;;
    4)
        llm_provider="openai"
        echo ""
        echo -e "  ${CYAN}→ Account erstellen: https://platform.openai.com${NC}"
        echo -e "  ${CYAN}→ API-Key holen:     https://platform.openai.com/api-keys${NC}"
        echo ""
        read -p "  OpenAI API-Key (sk-...): " openai_key_llm
        [ -z "$openai_key_llm" ] && fail "API-Key ist erforderlich!"
        read -p "  Modell [gpt-4o]: " openai_model
        openai_model="${openai_model:-gpt-4o}"
        ;;
esac

ok "LLM-Provider: ${BOLD}$llm_provider${NC}"

# ============================================================
#  3. Telegram-Konfiguration
# ============================================================
header "Telegram (Pflicht)"

echo "  Du brauchst einen Telegram Bot-Token."
echo ""
echo -e "  ${CYAN}So geht's:${NC}"
echo "  1. Telegram öffnen und @BotFather anschreiben"
echo "  2. /newbot senden → Bot-Name und Username wählen"
echo "  3. Den Token kopieren (sieht aus wie: 123456:ABC-DEF...)"
echo ""

read -p "  Bot-Token: " telegram_token
[ -z "$telegram_token" ] && fail "Telegram Bot-Token ist erforderlich!"

echo ""
echo "  Telegram User-IDs einschränken (optional)."
echo "  Nur diese User können mit dem Bot sprechen."
echo -e "  ${CYAN}→ Deine User-ID findest du bei @userinfobot in Telegram${NC}"
echo "  Leer lassen = jeder darf (nicht empfohlen)."
echo ""
read -p "  Erlaubte User-IDs (kommagetrennt): " telegram_users

ok "Telegram konfiguriert"

# ============================================================
#  4. Optionale Features
# ============================================================
header "Optionale Features"
echo "  Aktiviere nur was du brauchst. Alles kann später"
echo -e "  in der ${BOLD}.env${NC} nachkonfiguriert werden.\n"

# --- Sprachnachrichten ---
echo -e "  ${BOLD}Sprachnachrichten${NC} — Sprache-zu-Text (Whisper) + Text-zu-Sprache (Edge-TTS)"
echo "  Kostenlos, wird lokal in einem Python-venv installiert."
echo "  Braucht ca. 500 MB Speicher für das Basis-Modell."
echo ""
read -p "  Sprachnachrichten aktivieren? [j/N]: " opt_voice
opt_voice="${opt_voice:-n}"
whisper_model="base"
tts_voice="de-DE-KillianNeural"
if [[ "$opt_voice" =~ ^[jJyY]$ ]]; then
    read -p "    Whisper-Modell (tiny/base/small/medium) [base]: " whisper_model
    whisper_model="${whisper_model:-base}"
    echo -e "    ${CYAN}→ TTS-Stimmen: https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571a4c138${NC}"
    read -p "    TTS-Stimme [de-DE-KillianNeural]: " tts_voice
    tts_voice="${tts_voice:-de-DE-KillianNeural}"
    ok "Sprachnachrichten aktiviert (Whisper: $whisper_model)"
else
    info "Sprachnachrichten übersprungen"
fi

echo ""

# --- Home Assistant ---
echo -e "  ${BOLD}Home Assistant${NC} — Smart Home Steuerung (Licht, Heizung, Sensoren...)"
echo "  Brauchst du nur wenn du Home Assistant betreibst."
echo ""
read -p "  Home Assistant Integration? [j/N]: " opt_ha
opt_ha="${opt_ha:-n}"
ha_url=""
ha_token=""
if [[ "$opt_ha" =~ ^[jJyY]$ ]]; then
    read -p "    Home Assistant URL [http://homeassistant.local:8123]: " ha_url
    ha_url="${ha_url:-http://homeassistant.local:8123}"
    echo -e "    ${CYAN}→ Token erstellen: HA → Profil (unten links) → Langlebige Zugriffstokens${NC}"
    read -p "    Long-Lived Access Token: " ha_token
    [ -z "$ha_token" ] && warn "Kein Token angegeben — muss später in .env gesetzt werden"
    ok "Home Assistant konfiguriert"
else
    info "Home Assistant übersprungen"
fi

echo ""

# --- Kerio Mail ---
echo -e "  ${BOLD}Kerio Connect${NC} — E-Mail, Kalender, Kontakte, Aufgaben"
echo "  Nur wenn du einen Kerio Connect Mailserver betreibst."
echo ""
read -p "  Kerio Connect Integration? [j/N]: " opt_kerio
opt_kerio="${opt_kerio:-n}"
kerio_host=""
kerio_user=""
kerio_pass=""
kerio_from=""
if [[ "$opt_kerio" =~ ^[jJyY]$ ]]; then
    read -p "    Mail-Server Host: " kerio_host
    [ -z "$kerio_host" ] && fail "Host ist erforderlich!"
    read -p "    Benutzername: " kerio_user
    [ -z "$kerio_user" ] && fail "Benutzername ist erforderlich!"
    read -s -p "    Passwort: " kerio_pass
    echo ""
    [ -z "$kerio_pass" ] && fail "Passwort ist erforderlich!"
    read -p "    Absender (z.B. $bot_name <$kerio_user@$kerio_host>): " kerio_from
    kerio_from="${kerio_from:-$bot_name <$kerio_user@$kerio_host>}"
    ok "Kerio Mail konfiguriert"
else
    info "Kerio Mail übersprungen"
fi

echo ""

# --- DALL-E ---
echo -e "  ${BOLD}DALL-E${NC} — KI-Bildgenerierung (braucht OpenAI API-Key)"
echo -e "  ${CYAN}→ API-Key: https://platform.openai.com/api-keys${NC}"
echo ""
read -p "  DALL-E Bildgenerierung? [j/N]: " opt_dalle
opt_dalle="${opt_dalle:-n}"
openai_key_dalle=""
if [[ "$opt_dalle" =~ ^[jJyY]$ ]]; then
    if [ -n "$openai_key_llm" ]; then
        openai_key_dalle="$openai_key_llm"
        ok "Nutze bereits eingegebenen OpenAI API-Key"
    else
        read -p "    OpenAI API-Key (sk-...): " openai_key_dalle
        [ -z "$openai_key_dalle" ] && warn "Kein Key angegeben — muss später in .env gesetzt werden"
    fi
    ok "DALL-E aktiviert"
else
    info "DALL-E übersprungen"
fi

echo ""

# --- Wissensbasis Git-Backup ---
echo -e "  ${BOLD}Wissensbasis Git-Backup${NC} — Notizen automatisch in ein Git-Repo sichern"
echo "  Die Wissensbasis funktioniert auch ohne Git (lokal in notes/)."
echo ""
read -p "  Git-Backup aktivieren? [j/N]: " opt_kb_git
opt_kb_git="${opt_kb_git:-n}"
kb_git_repo=""
if [[ "$opt_kb_git" =~ ^[jJyY]$ ]]; then
    read -p "    Git Repo-URL (z.B. git@github.com:user/notes.git): " kb_git_repo
    [ -z "$kb_git_repo" ] && warn "Keine Repo-URL — muss später in .env gesetzt werden"
    ok "Git-Backup konfiguriert"
else
    info "Git-Backup übersprungen"
fi

# ============================================================
#  5. Monitor Dashboard
# ============================================================
header "Monitor Dashboard"

echo "  Das Web-Dashboard zeigt Konversationen, bietet"
echo "  Push-to-Talk und einen Smart-Home-Editor."
echo ""

read -p "  Monitor aktivieren? [J/n]: " opt_monitor
opt_monitor="${opt_monitor:-j}"
monitor_port="3333"
monitor_user=""
monitor_pass=""
if [[ "$opt_monitor" =~ ^[jJyY]$ ]]; then
    read -p "    Port [3333]: " monitor_port
    monitor_port="${monitor_port:-3333}"
    read -p "    Benutzername [admin]: " monitor_user
    monitor_user="${monitor_user:-admin}"
    read -s -p "    Passwort: " monitor_pass
    echo ""
    [ -z "$monitor_pass" ] && warn "Kein Passwort — muss später in .env gesetzt werden"
    ok "Monitor auf Port $monitor_port konfiguriert"
else
    info "Monitor übersprungen"
fi

# ============================================================
#  Bestätigung
# ============================================================
header "Zusammenfassung"

echo -e "  ${BOLD}Bot-Name:${NC}        $bot_name"
echo -e "  ${BOLD}Besitzer:${NC}        $owner_name ($owner_city)"
echo -e "  ${BOLD}Sprache:${NC}         $([ "$bot_lang" = "de" ] && echo "Deutsch" || echo "English")"
echo -e "  ${BOLD}Zeitzone:${NC}        $timezone"
echo -e "  ${BOLD}LLM-Provider:${NC}    $llm_provider"
echo -e "  ${BOLD}Telegram:${NC}        Token gesetzt"
[ -n "$telegram_users" ] && echo -e "  ${BOLD}Erlaubte User:${NC}   $telegram_users"
echo ""
echo -e "  ${BOLD}Features:${NC}"
[[ "$opt_voice" =~ ^[jJyY]$ ]]   && echo "    ✓ Sprachnachrichten (Whisper $whisper_model)" || echo "    ✗ Sprachnachrichten"
[[ "$opt_ha" =~ ^[jJyY]$ ]]      && echo "    ✓ Home Assistant"                              || echo "    ✗ Home Assistant"
[[ "$opt_kerio" =~ ^[jJyY]$ ]]   && echo "    ✓ Kerio Mail/Kalender/Kontakte"                || echo "    ✗ Kerio Mail"
[[ "$opt_dalle" =~ ^[jJyY]$ ]]   && echo "    ✓ DALL-E Bildgenerierung"                      || echo "    ✗ DALL-E"
[[ "$opt_kb_git" =~ ^[jJyY]$ ]]  && echo "    ✓ Wissensbasis Git-Backup"                     || echo "    ✗ Wissensbasis Git-Backup"
[[ "$opt_monitor" =~ ^[jJyY]$ ]] && echo "    ✓ Monitor Dashboard (:$monitor_port)"           || echo "    ✗ Monitor Dashboard"
echo ""

read -p "  Installation starten? [J/n]: " confirm
confirm="${confirm:-j}"
if [[ ! "$confirm" =~ ^[jJyY]$ ]]; then
    echo ""
    warn "Abgebrochen."
    exit 0
fi

# ============================================================
#  6. Installation
# ============================================================
header "Installation"

# --- System-Pakete ---
echo -e "${BOLD}[1/7]${NC} System-Pakete..."
sudo apt update -qq
sudo apt install -y -qq curl git ffmpeg openssl python3 python3-venv lm-sensors build-essential sqlite3 2>/dev/null
ok "System-Pakete installiert"

# --- Node.js ---
echo ""
echo -e "${BOLD}[2/7]${NC} Node.js..."
if command -v node &>/dev/null; then
    ok "Node.js bereits installiert: $(node --version)"
else
    info "Installiere Node.js v24..."
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y -qq nodejs
    ok "Node.js $(node --version) installiert"
fi

# --- NPM Dependencies ---
echo ""
echo -e "${BOLD}[3/7]${NC} NPM Packages..."
npm install --production 2>/dev/null
ok "NPM Packages installiert"

# --- Python venv (nur wenn Sprache aktiviert) ---
echo ""
echo -e "${BOLD}[4/7]${NC} Python venv..."
if [[ "$opt_voice" =~ ^[jJyY]$ ]]; then
    if [ ! -d "venv" ]; then
        python3 -m venv venv
        info "Python venv erstellt"
    fi
    source venv/bin/activate
    pip install --quiet --upgrade pip
    pip install --quiet edge-tts openai-whisper
    deactivate
    ok "edge-tts + whisper installiert"
else
    ok "Übersprungen (Sprache nicht aktiviert)"
fi

# --- Verzeichnisse + SSL ---
echo ""
echo -e "${BOLD}[5/7]${NC} Verzeichnisse + Zertifikate..."
mkdir -p temp logs notes certs

if [[ "$opt_monitor" =~ ^[jJyY]$ ]] && [ ! -f "certs/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout certs/key.pem -out certs/cert.pem \
        -days 3650 -subj "/CN=$bot_name_lower/O=$bot_name_upper/C=DE" 2>/dev/null
    ok "SSL-Zertifikate erstellt"
else
    ok "Verzeichnisse angelegt"
fi

# --- .env generieren ---
echo ""
echo -e "${BOLD}[6/7]${NC} Konfiguration (.env)..."

# Hilfsfunktion: auskommentiert wenn leer
env_line() {
    local key="$1"
    local val="$2"
    if [ -n "$val" ]; then
        echo "$key=$val"
    else
        echo "#$key="
    fi
}

cat > .env << ENVEOF
# ============================================================
# $bot_name – Konfiguration
# Generiert am $(date +%Y-%m-%d) durch install.sh
# ============================================================

# --- LLM Provider ---
LLM_PROVIDER=$llm_provider

# --- Anthropic ---
$(env_line "ANTHROPIC_API_KEY" "$anthropic_key")
$(env_line "CLAUDE_MODEL" "$claude_model")

# --- Ollama ---
$(env_line "OLLAMA_BASE_URL" "$ollama_url")
$(env_line "OLLAMA_MODEL" "$ollama_model")

# --- Groq ---
$(env_line "GROQ_API_KEY" "$groq_key")
$(env_line "GROQ_MODEL" "$groq_model")

# --- OpenAI (LLM + DALL-E) ---
$(env_line "OPENAI_API_KEY" "${openai_key_llm:-$openai_key_dalle}")
$([ "$llm_provider" = "openai" ] && env_line "OPENAI_MODEL" "$openai_model" || echo "#OPENAI_MODEL=")

# --- Telegram ---
TELEGRAM_TOKEN=$telegram_token
$(env_line "TELEGRAM_ALLOWED_USERS" "$telegram_users")

# --- Personalisierung ---
OWNER_NAME=$owner_name
OWNER_CITY=$owner_city
BOT_NAME=$bot_name
BOT_LANG=$bot_lang
TZ=$timezone

# --- Allgemein ---
MAX_TOKENS=4096

# --- Sprachnachrichten ---
$([[ "$opt_voice" =~ ^[jJyY]$ ]] && echo "WHISPER_MODEL=$whisper_model" || echo "#WHISPER_MODEL=base")
$([[ "$opt_voice" =~ ^[jJyY]$ ]] && echo "TTS_VOICE=$tts_voice" || echo "#TTS_VOICE=de-DE-KillianNeural")

# --- Kerio Connect ---
$(env_line "KERIO_HOST" "$kerio_host")
$(env_line "KERIO_USER" "$kerio_user")
$(env_line "KERIO_PASSWORD" "$kerio_pass")
$(env_line "KERIO_FROM" "$kerio_from")

# --- Home Assistant ---
$(env_line "HOMEASSISTANT_URL" "$ha_url")
$(env_line "HOMEASSISTANT_TOKEN" "$ha_token")

# --- Monitor ---
$(env_line "MONITOR_USER" "$monitor_user")
$(env_line "MONITOR_PASS" "$monitor_pass")
$([[ "$opt_monitor" =~ ^[jJyY]$ ]] && echo "MONITOR_PORT=$monitor_port" || echo "#MONITOR_PORT=3333")

# --- Wissensbasis Git Sync ---
$(env_line "GITHUB_NOTES_REPO" "$kb_git_repo")
ENVEOF

ok ".env generiert"

# JSON-Dateien
[ -f "memory.json" ]    || echo '{"facts":[],"todos":[],"notes":[]}' > memory.json
[ -f "reminders.json" ] || echo '[]' > reminders.json
ok "Datendateien angelegt"

# --- Systemd Service ---
echo ""
echo -e "${BOLD}[7/7]${NC} Systemd Service..."

service_name="${bot_name_lower}-telegram"
SERVICE_FILE="/etc/systemd/system/${service_name}.service"

if [ -f "$SERVICE_FILE" ]; then
    ok "Service ${service_name} existiert bereits"
else
    sudo tee "$SERVICE_FILE" > /dev/null << SVCEOF
[Unit]
Description=$bot_name Telegram Bot
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
SyslogIdentifier=$service_name

Environment=HOME=$HOME TZ=$timezone

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$PROJECT_DIR $HOME/.cache /tmp

[Install]
WantedBy=multi-user.target
SVCEOF
    sudo systemctl daemon-reload
    sudo systemctl enable "$service_name"
    ok "Service ${BOLD}${service_name}${NC} erstellt und aktiviert"
fi

# --- Git-Backup für Wissensbasis ---
if [[ "$opt_kb_git" =~ ^[jJyY]$ ]] && [ -n "$kb_git_repo" ] && [ ! -d "notes/.git" ]; then
    echo ""
    info "Richte notes/ Git-Repo ein..."
    cd notes
    git init -q
    git config user.name "$bot_name"
    git config user.email "${bot_name_lower}@server"
    git remote add origin "$kb_git_repo" 2>/dev/null || true
    cd "$PROJECT_DIR"
    ok "notes/ Git-Repo initialisiert"
fi

# ============================================================
#  7. Zusammenfassung
# ============================================================
echo ""
echo -e "${CYAN}"
echo "  ══════════════════════════════════════════"
echo "   Installation abgeschlossen!"
echo "  ══════════════════════════════════════════"
echo -e "${NC}"

echo -e "  ${BOLD}Nächste Schritte:${NC}\n"

echo "  1. Prüfe deine Konfiguration:"
echo -e "     ${CYAN}nano $PROJECT_DIR/.env${NC}"
echo ""
echo "  2. Starte den Bot:"
echo -e "     ${CYAN}sudo systemctl start ${service_name}${NC}"
echo ""
echo "  3. Logs anschauen:"
echo -e "     ${CYAN}sudo journalctl -u ${service_name} -f${NC}"
echo ""

if [[ "$opt_monitor" =~ ^[jJyY]$ ]]; then
    echo "  4. Monitor Dashboard öffnen:"
    echo -e "     ${CYAN}https://<server-ip>:${monitor_port}${NC}"
    echo ""
fi

echo -e "  ${BOLD}Installiert:${NC}"
echo "    • Node.js $(node --version 2>/dev/null || echo 'v24')"
echo "    • $(npm ls --depth=0 2>/dev/null | grep -c '─') NPM Packages"
[[ "$opt_voice" =~ ^[jJyY]$ ]] && echo "    • Python venv (Whisper + Edge-TTS)"
echo "    • Systemd Service: ${service_name}"
[[ "$opt_monitor" =~ ^[jJyY]$ ]] && echo "    • Monitor Dashboard (Port ${monitor_port})"
[[ "$opt_ha" =~ ^[jJyY]$ ]] && echo "    • Home Assistant Integration"
[[ "$opt_kerio" =~ ^[jJyY]$ ]] && echo "    • Kerio Mail/Kalender/Kontakte"
[[ "$opt_dalle" =~ ^[jJyY]$ ]] && echo "    • DALL-E Bildgenerierung"
[[ "$opt_kb_git" =~ ^[jJyY]$ ]] && echo "    • Wissensbasis Git-Backup"

echo ""
echo -e "  ${GREEN}Viel Spaß mit $bot_name!${NC}"
echo ""
