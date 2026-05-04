#!/bin/bash
# ============================================================
# Docker Engine + Compose-Plugin auf Ubuntu 24.04 installieren
# Idempotent — kann mehrfach ausgeführt werden.
# ============================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC}  $1"; }
fail() { echo -e "${RED}[FEHLER]${NC} $1"; exit 1; }

echo "============================================"
echo "  Docker-Installation für kiasy v2"
echo "============================================"

[ "$(id -u)" -ne 0 ] && SUDO="sudo" || SUDO=""

# --- Bereits installiert? ---
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker bereits installiert: $(docker --version)"
  ok "Compose-Plugin:             $(docker compose version --short)"
  exit 0
fi

# --- Alte unofficial-Pakete entfernen ---
echo ""
echo "→ Alte Docker-Pakete entfernen (falls vorhanden)"
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  $SUDO apt-get remove -y "$pkg" 2>/dev/null || true
done

# --- Docker Repo + GPG ---
echo ""
echo "→ Docker APT-Repo einrichten"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq ca-certificates curl gnupg

$SUDO install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
$SUDO chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

# --- Docker installieren ---
echo ""
echo "→ docker-ce + Compose-Plugin installieren"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

ok "Docker installiert: $(docker --version)"
ok "Compose:            $(docker compose version --short)"

# --- User in docker-Gruppe ---
USER_TO_ADD="${SUDO_USER:-$USER}"
if id -nG "$USER_TO_ADD" | grep -qw docker; then
  ok "User '$USER_TO_ADD' bereits in Gruppe 'docker'"
else
  echo ""
  echo "→ User '$USER_TO_ADD' zur Gruppe 'docker' hinzufügen"
  $SUDO usermod -aG docker "$USER_TO_ADD"
  warn "Logout/Login (oder: newgrp docker) nötig, damit Docker ohne sudo funktioniert"
fi

# --- Service starten + enablen ---
$SUDO systemctl enable --now docker
ok "Docker-Service läuft"

echo ""
echo "============================================"
echo "  Fertig. Nächster Schritt:"
echo "    cd /home/mcde/kiasy"
echo "    cp .env.example .env  # und Werte eintragen"
echo "    bash scripts/smoke-test.sh"
echo "============================================"
