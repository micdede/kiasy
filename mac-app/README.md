# JARVIS — macOS Menübar-App

Native Swift/SwiftUI Menübar-App, die mit dem JARVIS-Server (Monitor-API) spricht.
Nutzt denselben Chat-Thread wie Telegram/Monitor — du siehst überall identischen Verlauf.

## Voraussetzungen

- macOS 13 (Ventura) oder neuer
- Xcode 15+ (oder nur Command Line Tools: `xcode-select --install`)
- Erreichbarer JARVIS-Server (im gleichen LAN oder per VPN)

## Phase 1 — was funktioniert

- Menübar-Icon mit Popover
- Text-Eingabe → Antwort vom Agent
- Verlauf laden/löschen
- Einstellungen (Server-URL, Benutzer, Passwort) — Passwort im macOS-Keychain
- Self-Signed-Cert wird akzeptiert

(Voice + TTS + Hotkey kommen in Phase 2.)

## Bauen

Im Terminal in diesem Ordner:

```bash
./build.sh
```

Das erzeugt `build/Jarvis.app`. Doppelklick startet die App, oder:

```bash
open build/Jarvis.app
```

Optional in `/Applications` kopieren:

```bash
cp -r build/Jarvis.app /Applications/
```

## Erste Einrichtung

1. App starten — Icon erscheint in der Menüleiste (Gehirn-Symbol)
2. Klick auf das Icon öffnet den Popover. Beim ersten Start öffnet sich automatisch die Einstellungen.
3. Eintragen:
   - **Server-URL:** `https://192.168.178.x:3333` (deine JARVIS-IP)
   - **Benutzername:** Wert von `MONITOR_USER` aus `.env`
   - **Passwort:** Wert von `MONITOR_PASS` aus `.env`
4. **Verbindung testen** klicken — wenn der Verlauf lädt, passt alles.

## In Xcode öffnen (optional)

Du kannst `Package.swift` direkt mit Doppelklick in Xcode öffnen — Xcode versteht Swift Packages nativ. Dort kannst du auch debuggen (⌘R startet die App, allerdings ohne `.app`-Bundle und damit mit Dock-Icon — für richtigen Menübar-Modus immer `./build.sh` nutzen).

## Troubleshooting

- **"Jarvis can't be opened because it is from an unidentified developer":**
  Rechtsklick auf `Jarvis.app` → **Öffnen** → **Öffnen** im Dialog. Nur einmal nötig.
- **Verbindung schlägt fehl:**
  - URL korrekt? Mit `https://` und Port `:3333`?
  - Bist du im LAN bzw. VPN aktiv?
  - JARVIS-Server läuft? Test im Browser: `https://<ip>:3333/`
- **"Ungültige Server-URL":**
  Format prüfen: `https://192.168.178.42:3333` (kein Slash am Ende)

## Struktur

```
mac-app/
├── Package.swift              ← Swift Package Definition
├── Sources/Jarvis/
│   ├── JarvisApp.swift        ← @main + MenuBarExtra
│   ├── AppState.swift         ← Settings + Chat-Verwaltung
│   ├── Networking.swift       ← HTTP-Client (Self-Signed-Cert ok)
│   ├── ChatView.swift         ← Popover-UI
│   ├── SettingsView.swift     ← Einstellungs-Sheet
│   └── Keychain.swift         ← Passwort-Speicherung
├── Resources/Info.plist       ← LSUIElement, Mic-Permission, Bundle-Meta
├── build.sh                   ← Baut Jarvis.app
└── README.md
```
