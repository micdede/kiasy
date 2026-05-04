#!/bin/bash
# ============================================================
# kiasy v2 — Daten-Migration vom Alt-System (whatsapp-claude)
#
# Importiert State aus einem v1-Backup-Tarball in die v2-Volumes:
#   - jarvis.db      → data/jarvis.db
#   - notes/         → notes/
#   - credentials.json, memory.json, reminders.json → data/
#   - Qdrant-Snapshot → kiasy-qdrant Collection 'jarvis_memory'
#   - V2-Patch-SQL: ergänzt 'migrations' und 'labs_items' Tabellen
#
# Usage:
#   bash scripts/migrate-from-v1.sh <pfad/zum/tarball.tar.gz>
#
# Falls kein Argument: nimmt das neueste Tarball aus
#   /home/mcde/whatsapp-claude/backups/
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC}  $1"; }
fail() { echo -e "${RED}[FEHLER]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}→${NC} $1"; }

# --- Argument: Tarball-Pfad ---
if [ $# -ge 1 ]; then
  TARBALL="$(realpath "$1")"
else
  V1_BACKUPS="/home/mcde/whatsapp-claude/backups"
  TARBALL=$(ls -t "$V1_BACKUPS"/jarvis-*.tar.gz 2>/dev/null | head -1)
  [ -z "$TARBALL" ] && fail "Kein Backup gefunden in $V1_BACKUPS"
  info "Nehme neuestes Backup: $TARBALL"
fi
[ -f "$TARBALL" ] || fail "Tarball nicht gefunden: $TARBALL"

# --- Vorbedingungen ---
command -v python3 >/dev/null || fail "python3 fehlt"
command -v docker  >/dev/null || fail "docker fehlt"
[ -f docker-compose.yml ] || fail "docker-compose.yml fehlt — falscher Pfad?"

if ! sudo docker compose ps --status running --format '{{.Name}}' 2>/dev/null | grep -q kiasy-qdrant; then
  fail "kiasy-qdrant läuft nicht — erst: sudo docker compose up -d"
fi

# --- Stage entpacken ---
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "============================================"
echo "  kiasy v2 — Daten-Migration"
echo "============================================"
echo "Tarball:  $TARBALL"
echo "Stage:    $STAGE"
echo ""

info "Tarball entpacken"
tar -xzf "$TARBALL" -C "$STAGE"
[ -f "$STAGE/MANIFEST.txt" ] || fail "Kein gültiges Backup (MANIFEST.txt fehlt)"

echo ""
echo "Manifest:"
echo "---------"
head -25 "$STAGE/MANIFEST.txt"
echo ""

read -r -p "Migration starten? [y/N] " ANSWER
case "${ANSWER:-N}" in
  y|Y|yes|YES) ;;
  *) fail "Abgebrochen" ;;
esac

# --- 1. SQLite-DB ---
echo ""
info "jarvis.db → data/jarvis.db"
mkdir -p data
cp "$STAGE/state/jarvis.db" data/jarvis.db
ok "DB ($(du -h data/jarvis.db | cut -f1))"

# --- 2. Notes ---
echo ""
if [ -d "$STAGE/state/notes" ]; then
  if [ ! "$(ls -A notes 2>/dev/null | grep -v '^\.git$')" ]; then
    cp -a "$STAGE/state/notes/." notes/
    ok "Notes übernommen ($(find notes -name '*.md' | wc -l) MD-Files)"
  else
    warn "notes/ enthält schon Files — übersprungen (manuell prüfen)"
  fi
fi

# --- 3. Legacy-State-Files ---
echo ""
info "Legacy State (credentials.json, memory.json, reminders.json)"
for f in credentials.json memory.json reminders.json .last-telegram-chat .onboarded; do
  if [ -f "$STAGE/state/$f" ]; then
    cp "$STAGE/state/$f" "data/$f"
    ok "  + data/$f"
  fi
done

# --- 4. V2-Patch-SQL anwenden ---
echo ""
info "V2-Patch-SQL: WAL-Checkpoint + Tabellen 'migrations' und 'labs_items'"
python3 <<'PY'
import sqlite3, os
db = sqlite3.connect("data/jarvis.db")
db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
db.executescript("""
CREATE TABLE IF NOT EXISTS migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS labs_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT,
    type        TEXT NOT NULL DEFAULT 'idea',
    status      TEXT NOT NULL DEFAULT 'idee',
    tool_link   TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_labs_status ON labs_items(status);
CREATE INDEX IF NOT EXISTS idx_labs_type   ON labs_items(type);
INSERT OR IGNORE INTO migrations(name) VALUES ('001_init');
""")
db.commit()
print("[python] V2-Patch angewandt.")

print("\n[python] Tabellen-Counts:")
for tbl in ['messages','memory','reminders','kb_notes','events','workflows','workflow_steps','tool_settings','news_sources','delegations','delegation_tasks','labs_items','migrations']:
    try:
        n = db.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        print(f"  {tbl:20s} {n:>6d}")
    except Exception as e:
        print(f"  {tbl:20s} (fehlt: {e})")
db.close()
PY
ok "Schema gepatcht"

# --- 5. Qdrant-Snapshot importieren ---
echo ""
if [ -f "$STAGE/qdrant/snapshot.name" ]; then
  SNAP_NAME=$(cat "$STAGE/qdrant/snapshot.name")
  COLLECTION=$(cat "$STAGE/qdrant/collection.name")
  SNAP_FILE="$STAGE/qdrant/$SNAP_NAME"

  info "Qdrant: Snapshot $SNAP_NAME → kiasy-qdrant ($COLLECTION)"

  # Existiert Collection schon? Wenn ja, vorher löschen (wir wollen sauberen Zustand)
  EXISTS=$(sudo docker run --rm --network kiasy_kiasy-net curlimages/curl:latest \
    -sfm 5 -o /dev/null -w "%{http_code}" \
    "http://qdrant:6333/collections/$COLLECTION" 2>/dev/null || echo "FAIL")
  if [ "$EXISTS" = "200" ]; then
    warn "Collection existiert bereits — wird ersetzt"
    sudo docker run --rm --network kiasy_kiasy-net curlimages/curl:latest \
      -sfm 10 -o /dev/null -X DELETE "http://qdrant:6333/collections/$COLLECTION" >/dev/null 2>&1 || true
  fi

  HTTP=$(sudo docker run --rm --network kiasy_kiasy-net \
    -v "$SNAP_FILE:/snap.snapshot:ro" \
    curlimages/curl:latest -sfm 120 -o /dev/null -w "%{http_code}" \
    -X POST "http://qdrant:6333/collections/$COLLECTION/snapshots/upload?priority=snapshot" \
    -F "snapshot=@/snap.snapshot")

  if [ "$HTTP" = "200" ]; then
    POINTS=$(sudo docker run --rm --network kiasy_kiasy-net curlimages/curl:latest \
      -sfm 5 "http://qdrant:6333/collections/$COLLECTION" 2>/dev/null | \
      grep -oE '"points_count":[0-9]+' | head -1 | cut -d: -f2)
    ok "Qdrant: ${POINTS:-?} Punkte in '$COLLECTION'"
  else
    warn "Qdrant-Upload fehlgeschlagen (HTTP $HTTP)"
  fi
else
  warn "Kein Qdrant-Snapshot im Backup — übersprungen"
fi

# --- 6. Container neu starten damit /data frisch gelesen wird ---
echo ""
info "kiasy-core neu starten (damit DB-Pfad neu gelesen wird, falls schon offen)"
sudo docker compose restart kiasy-core >/dev/null 2>&1 || true
ok "Restart"

echo ""
echo "============================================"
ok "Migration abgeschlossen"
echo "============================================"
echo ""
echo "Verifizieren:"
echo "  curl -ks https://192.168.178.50/api/status"
echo ""
echo "Phase 3 (Code-Port) kann jetzt anfangen."
