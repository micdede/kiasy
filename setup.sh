#!/bin/bash
set -e

echo "=== WhatsApp-Claude Bot Setup ==="
echo ""

# Node.js prüfen
if ! command -v node &> /dev/null; then
    echo "FEHLER: Node.js ist nicht installiert."
    echo "Installiere mit: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v)
echo "Node.js Version: $NODE_VERSION"

# Dependencies installieren
echo ""
echo "Installiere Abhängigkeiten..."
npm install

# .env prüfen
if grep -q "DEIN-API-KEY-HIER" .env; then
    echo ""
    echo "WICHTIG: Bitte trage deinen Anthropic API-Key in die .env Datei ein:"
    echo "  nano .env"
    echo ""
fi

# systemd-Service einrichten
echo ""
read -p "Systemd-Service einrichten? (j/n): " SETUP_SYSTEMD
if [[ "$SETUP_SYSTEMD" == "j" ]]; then
    sudo cp whatsapp-claude.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable whatsapp-claude
    echo ""
    echo "Service eingerichtet. Starte ZUERST manuell, um den QR-Code zu scannen:"
    echo "  npm start"
    echo ""
    echo "Danach den Service starten:"
    echo "  sudo systemctl start whatsapp-claude"
    echo "  sudo journalctl -u whatsapp-claude -f  # Logs anzeigen"
else
    echo ""
    echo "Manuell starten mit:"
    echo "  npm start"
fi

echo ""
echo "Setup abgeschlossen!"
