# JarvisApp — iOS-Client für JARVIS

SwiftUI-App für Push-to-Talk-Dialog mit dem JARVIS-Backend (`/api/chat/send/stream`).

## Features (Phase 1)
- Push-to-Talk mit on-device `SFSpeechRecognizer` (deutsch)
- POST + SSE-Streaming an `/api/chat/send/stream`
- TTS via `AVSpeechSynthesizer` (System-Stimme oder Premium/Enhanced wenn verfügbar)
- Einstellungen für Backend-URL, Basic-Auth, Chat-ID, Stimme

## Setup auf dem Mac (einmalig)

```bash
# 1. XcodeGen installieren
brew install xcodegen

# 2. Repo holen (oder bestehendes Klon updaten)
git clone git@github.com:micdede/kiasy.git
cd kiasy/ios

# 3. .xcodeproj generieren
xcodegen generate

# 4. Öffnen
open JarvisApp.xcodeproj
```

In Xcode:
- Target **JarvisApp** → **Signing & Capabilities** → Team auswählen (dein Apple Developer Account)
- Bundle-ID ist `de.dedecke.jarvis` (in `project.yml` änderbar)
- iPhone via USB anschließen oder Simulator wählen → ⌘R

Bei Source-Änderungen reicht in Xcode normales Reload — die Files sind als Folder-Reference eingebunden, neue Dateien tauchen nach `xcodegen generate` automatisch im Projekt auf.

## Erster Start auf dem iPhone
1. App startet, fragt Mikrofon + Spracherkennung an → erlauben
2. Zahnrad oben rechts → Backend-URL eintragen (Default: `https://192.168.178.50`)
3. User/Passwort = MONITOR_USER / MONITOR_PASS aus deiner `.env`
4. „Verbindung testen" — sollte HTTP 200 zeigen
5. Zurück zum Hauptscreen → Mikrofon-Button drücken, sprechen, nochmal drücken zum Senden

## Self-signed Cert (Caddy)
Die App akzeptiert per `URLSessionDelegate` jedes Server-Cert (Dev-Setup). In der `Info.plist` steht zusätzlich `NSAllowsArbitraryLoads=true`.

Sauberer für später: Caddy-Root-Cert aufs iPhone als Profile installieren und die beiden Workarounds rausnehmen.

## Struktur

```
ios/
├── project.yml                       — XcodeGen-Spec
└── JarvisApp/
    ├── Sources/
    │   ├── JarvisApp.swift           — App-Entry
    │   ├── Models/
    │   │   ├── AppSettings.swift     — @AppStorage-Settings
    │   │   └── ChatMessage.swift
    │   ├── Services/
    │   │   ├── SpeechService.swift   — SFSpeechRecognizer
    │   │   ├── TTSService.swift      — AVSpeechSynthesizer
    │   │   └── JarvisAPI.swift       — SSE-Client
    │   └── Views/
    │       ├── ContentView.swift     — Haupt-UI
    │       └── SettingsView.swift
    └── Resources/                    — leer (Info.plist wird von XcodeGen generiert)
```

## Phase 2 (später)
- Streaming-TTS satzweise während Tokens
- Wake-Word („Hey Jarvis") via Picovoice oder lokaler Schwellwert
- Background-Audio + Lock-Screen-Controls
- Push-Notifications für proaktive JARVIS-Meldungen
- iOS-Shortcuts-Integration
