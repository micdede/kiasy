# JarvisApp — iOS-Client für JARVIS

SwiftUI-App für Voice + Text-Dialog mit dem JARVIS-Backend (`/api/chat/send/stream`). Tron-Theme, mehrere TTS-Backends, weltweit über Tailscale erreichbar.

## Features
- **Push-to-Talk + Tippen** (iMessage-Style Footer mit TextField + Mic/Send-Toggle)
- **STT**: SFSpeechRecognizer on-device (deutsch)
- **TTS-Backends** wählbar in Settings:
  - **iOS-Voices** (System / Premium / Enhanced via AVSpeechSynthesizer)
  - **Piper** (Server-side, Wyoming-Container)
  - **Edge-TTS** (Server-side, MS Read-Aloud — z.B. `de-DE-KillianNeural`)
  - Eigener Voice-Picker pro Backend, geladen vom Server (`/api/voice/voices?engine=…`)
- **Bilder**: `image_generate` Tool (Pollinations.ai) → URL → AsyncImage in Bubble
- **iCloud-Sync** für alle Settings (NSUbiquitousKeyValueStore) — sync zwischen iPhone/iPad mit gleicher Apple-ID, überlebt App-Reinstall
- **Server-side Chat-Verlauf**: beim App-Start wird Verlauf vom Server geladen (`/api/chat/history`) — Single Source of Truth ist die SQLite des Backends
- **Theme**: Tron-Style (Deep Navy + Cyan), AppIcon Cyber-AI-Kopf

## Setup auf dem Mac (einmalig)

```bash
# 1. XcodeGen installieren (z.B. via Homebrew oder ~/bin)
brew install xcodegen
# oder: aus Sourcen bauen → ~/bin/xcodegen

# 2. Repo holen
git clone git@github.com:micdede/kiasy.git
cd kiasy/ios

# 3. .xcodeproj generieren
xcodegen

# 4. Öffnen
open JarvisApp.xcodeproj
```

In Xcode (einmalig):
- Target **JarvisApp** → **Signing & Capabilities** → Team auswählen (Apple Developer Account; Free Personal Team funktioniert NICHT mit iCloud-Entitlement)
- Bundle-ID: `de.dedecke.jarvis` (in `project.yml` änderbar)
- iCloud-Capability erscheint automatisch (über `JarvisApp.entitlements`); falls Xcode beim Build meckert „doesn't include com.apple.developer.ubiquity-kvstore-identifier" → „Try Again"-Button löst es per Auto-Signing
- iPhone via USB anschließen oder Simulator wählen → ⌘R

## XcodeGen-Gotchas (im project.yml dokumentiert)
- `.xcassets` MUSS unter `sources:` stehen, NICHT unter `resources:` mit `type: folder.assetcatalog` — sonst wird kein PBXResourcesBuildPhase angelegt und das AppIcon nicht kompiliert
- Entitlements brauchen sowohl `entitlements:`-Block als auch `CODE_SIGN_ENTITLEMENTS` in `settings.base`

## Erster Start auf dem iPhone
1. App startet, fragt Mikrofon + Spracherkennung an → erlauben
2. Zahnrad oben rechts → Backend-URL eintragen
   - im LAN: `https://192.168.178.50`
   - weltweit: `https://jarvis.tailb8844c.ts.net` (Tailscale, MagicDNS)
3. User/Passwort = `MONITOR_USER` / `MONITOR_PASS` aus deiner `.env`
4. „Verbindung testen" — sollte HTTP 200 zeigen
5. Zurück zum Hauptscreen → Mikrofon-Button drücken, sprechen, nochmal drücken zum Senden

## TLS / Cert
- LAN/Self-Signed-Caddy: einmalig Caddy-Root-Cert als **Trusted Profile** auf dem iPhone installieren (Settings → Allgemein → Über → Zertifikatsvertrauen)
- Tailscale-Hostname (`*.ts.net`): echtes Let's Encrypt-Cert über Tailscale-Socket-Mount in Caddy → kein Profile nötig

## Struktur

```
ios/
├── project.yml                       — XcodeGen-Spec (sources, entitlements, Info.plist properties)
└── JarvisApp/
    ├── Sources/
    │   ├── JarvisApp.swift           — App-Entry, @StateObject AppSettings
    │   ├── Models/
    │   │   ├── AppSettings.swift     — iCloud-KV-Store-synchronisierte Settings
    │   │   └── ChatMessage.swift     — inkl. init?(serverDict:) für History-Reload
    │   ├── Services/
    │   │   ├── SpeechService.swift   — SFSpeechRecognizer
    │   │   ├── TTSService.swift      — iOS / Piper / Edge-Routing
    │   │   └── JarvisAPI.swift       — actor mit sendStream() + loadHistory()
    │   └── Views/
    │       ├── ContentView.swift     — Haupt-UI (Header, MessagesList, InputBar)
    │       └── SettingsView.swift
    └── Resources/
        ├── Info.plist                — Privacy-Strings, Bonjour, Background Audio
        ├── JarvisApp.entitlements    — iCloud KV-Store
        └── Assets.xcassets/          — AppIcon + AccentColor
```

## Roadmap
- **Wake-Word + Barge-In** (nächste Session) — Picovoice Porcupine, Built-in keyword `.jarvis`. ~5% CPU für Always-On. Toggle in Settings + AccessKey-Feld
- Streaming-TTS satzweise während Tokens
- Background-Audio + Lock-Screen-Controls
- Push-Notifications für proaktive JARVIS-Meldungen
- iOS-Shortcuts-Integration
