#!/bin/bash
# ============================================================
# kiasy v2 — Smoke-Test
# Fährt den Container-Stack hoch und prüft alle Health-Endpoints.
# Aufruf: bash scripts/smoke-test.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$SCRIPT_DIR")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC}  $1"; }
fail() { echo -e "${RED}[FEHLER]${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }

echo "============================================"
echo "  kiasy v2 — Smoke-Test"
echo "============================================"

# --- Docker prüfen ---
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker fehlt. Erst: bash scripts/install-docker.sh"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose fehlt"
  exit 1
fi

# --- .env prüfen ---
if [ ! -f .env ]; then
  warn ".env fehlt — kopiere .env.example"
  cp .env.example .env
  warn "Trag Werte in .env ein und starte erneut"
  exit 1
fi

# --- Stack hochfahren ---
echo ""
info "docker compose up -d --build"
docker compose up -d --build

# --- Auf Container warten ---
echo ""
info "Warte auf Container-Start (bis zu 60s)…"
for i in $(seq 1 30); do
  RUNNING=$(docker compose ps --status running --format json 2>/dev/null | wc -l)
  TOTAL=$(docker compose ps --format json 2>/dev/null | wc -l)
  printf "\r  [%2d/30] %s/%s laufen" "$i" "$RUNNING" "$TOTAL"
  [ "$RUNNING" = "$TOTAL" ] && [ "$RUNNING" -ge 7 ] && break
  sleep 2
done
echo ""

# --- Status-Übersicht ---
echo ""
info "Container-Status:"
docker compose ps

# --- Health-Checks ---
echo ""
info "Health-Checks (per docker exec ins kiasy-net):"

declare -A CHECKS=(
  ["kiasy-core"]="curl -sfm 3 http://kiasy-core:8080/health"
  ["kiasy-monitor"]="curl -sfm 3 http://kiasy-monitor:3000/health"
  ["qdrant"]="curl -sfm 3 http://qdrant:6333/"
  ["ollama"]="curl -sfm 3 http://ollama:11434/api/tags"
  ["whisper"]="curl -sfm 3 http://whisper:9000/"
  ["searxng"]="curl -sfm 3 http://searxng:8080/healthz"
)

PASS=0
FAIL=0
for name in kiasy-core kiasy-monitor qdrant ollama whisper searxng; do
  cmd="${CHECKS[$name]}"
  if docker compose exec -T kiasy-core sh -c "$cmd" >/dev/null 2>&1; then
    ok "$name"
    PASS=$((PASS + 1))
  else
    fail "$name (cmd: $cmd)"
    FAIL=$((FAIL + 1))
  fi
done

# Piper ist Wyoming TCP, kein HTTP — eigener Check
if docker compose exec -T kiasy-core sh -c "nc -zw3 piper 10200" >/dev/null 2>&1; then
  ok "piper (TCP 10200)"
  PASS=$((PASS + 1))
else
  fail "piper (TCP 10200 nicht erreichbar)"
  FAIL=$((FAIL + 1))
fi

# Caddy: Self-signed, also -k
if curl -ksfm 3 https://localhost:443/health >/dev/null 2>&1; then
  ok "caddy (HTTPS-Routing → kiasy-monitor /health)"
  PASS=$((PASS + 1))
else
  warn "caddy (HTTPS auf 443 — UI sollte trotzdem im Browser gehen)"
fi

echo ""
echo "============================================"
if [ "$FAIL" -eq 0 ]; then
  ok "Alle Checks grün ($PASS/$((PASS + FAIL)))"
  echo ""
  echo "Aufrufen im Browser:"
  echo "  https://$(hostname -I | awk '{print $1}'):443/"
  echo "  (Self-signed Cert akzeptieren)"
else
  fail "$FAIL Check(s) fehlgeschlagen ($PASS grün)"
  echo ""
  echo "Logs anschauen:  docker compose logs -f <service>"
  echo "Stack neu:       docker compose down && bash scripts/smoke-test.sh"
  exit 1
fi
echo "============================================"
