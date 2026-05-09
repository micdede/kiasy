import Foundation
import SwiftUI
import Combine

/// AppSettings mit iCloud-KV-Store-Sync.
///
/// Jeder Setter schreibt in UserDefaults (lokaler Cache, sofortiger Lese-Pfad)
/// UND in NSUbiquitousKeyValueStore (Apple-iCloud-Sync, max 1 MB / 1024 Keys).
/// Beim Start hat der Cloud-Wert Vorrang vor dem lokalen Wert (frisch installierte
/// App sieht so die zuletzt gesicherten Settings).
///
/// Externe Änderungen (anderes iPhone/iPad) kommen via
/// `NSUbiquitousKeyValueStore.didChangeExternallyNotification` rein und werden
/// in die @Published-Properties zurückgespielt.
@MainActor
final class AppSettings: ObservableObject {

    // ─── gespeicherte Werte ──────────────────────────────────
    @Published var backendURL:     String { didSet { sync("backendURL",     backendURL) } }
    @Published var authUser:       String { didSet { sync("authUser",       authUser) } }
    @Published var authPass:       String { didSet { sync("authPass",       authPass) } }
    @Published var chatId:         String { didSet { sync("chatId",         chatId) } }
    @Published var speakReplies:   Bool   { didSet { sync("speakReplies",   speakReplies) } }
    /// "ios" = on-device AVSpeechSynthesizer, "piper" = Server-Piper, "edge" = Server-Edge-TTS
    @Published var ttsBackend:     String { didSet { sync("ttsBackend",     ttsBackend) } }
    /// AVSpeechSynthesisVoice.identifier (leer = beste verfügbare de-DE)
    @Published var ttsVoiceID:     String { didSet { sync("ttsVoiceID",     ttsVoiceID) } }
    /// Piper-Stimme (z.B. "de_DE-thorsten-high"); leer = Server-Default
    @Published var piperVoice:     String { didSet { sync("piperVoice",     piperVoice) } }
    /// Edge-Stimme (z.B. "de-DE-KillianNeural"); leer = Server-Default
    @Published var edgeVoice:      String { didSet { sync("edgeVoice",      edgeVoice) } }
    /// true = während Tokens, false = am Ende
    @Published var speakStreaming: Bool   { didSet { sync("speakStreaming", speakStreaming) } }
    /// Picovoice Console AccessKey (https://console.picovoice.ai). Ohne den ist Wake-Word inaktiv.
    @Published var picovoiceAccessKey: String { didSet { sync("picovoiceAccessKey", picovoiceAccessKey) } }
    /// Wake-Word "Jarvis" aktiv (kontinuierliches Hören)
    @Published var wakeWordEnabled: Bool { didSet { sync("wakeWordEnabled", wakeWordEnabled) } }
    /// Barge-In: während TTS spricht "Jarvis" sagen → TTS abbrechen + neue Aufnahme
    @Published var bargeInEnabled: Bool { didSet { sync("bargeInEnabled", bargeInEnabled) } }
    /// Konversations-Modus: nach TTS automatisch wieder Mic auf für Folgefrage. Stoppt nach 6s Stille.
    @Published var conversationMode: Bool { didSet { sync("conversationMode", conversationMode) } }
    /// Voice-Mode Visualisierung: "sphere" (Default) oder "blackhole"
    @Published var orbStyle: String { didSet { sync("orbStyle", orbStyle) } }
    /// Particle-Form: "circle" (Default), "square", "diamond", "star"
    @Published var particleShape: String { didSet { sync("particleShape", particleShape) } }

    // ─── Internal ────────────────────────────────────────────
    private let kv = NSUbiquitousKeyValueStore.default
    private let ud = UserDefaults.standard
    /// Verhindert Schreib-Loop wenn ein externer Update reinkommt
    private var applyingRemote = false

    init() {
        // Defaults
        let defBackend = "https://192.168.178.50"
        let defChatId  = "ios-app"

        // Cloud hat Vorrang, dann UserDefaults, dann Default
        self.backendURL     = Self.read("backendURL",     kv: kv, ud: ud, default: defBackend)
        self.authUser       = Self.read("authUser",       kv: kv, ud: ud, default: "admin")
        self.authPass       = Self.read("authPass",       kv: kv, ud: ud, default: "")
        self.chatId         = Self.read("chatId",         kv: kv, ud: ud, default: defChatId)
        self.speakReplies   = Self.readBool("speakReplies",   kv: kv, ud: ud, default: true)
        self.ttsBackend     = Self.read("ttsBackend",     kv: kv, ud: ud, default: "ios")
        self.ttsVoiceID     = Self.read("ttsVoiceID",     kv: kv, ud: ud, default: "")
        self.piperVoice     = Self.read("piperVoice",     kv: kv, ud: ud, default: "")
        self.edgeVoice      = Self.read("edgeVoice",      kv: kv, ud: ud, default: "")
        self.speakStreaming = Self.readBool("speakStreaming", kv: kv, ud: ud, default: false)
        self.picovoiceAccessKey = Self.read("picovoiceAccessKey", kv: kv, ud: ud, default: "")
        self.wakeWordEnabled    = Self.readBool("wakeWordEnabled", kv: kv, ud: ud, default: false)
        self.bargeInEnabled     = Self.readBool("bargeInEnabled",  kv: kv, ud: ud, default: true)
        self.conversationMode   = Self.readBool("conversationMode", kv: kv, ud: ud, default: false)
        self.orbStyle           = Self.read("orbStyle",      kv: kv, ud: ud, default: "sphere")
        self.particleShape      = Self.read("particleShape", kv: kv, ud: ud, default: "circle")

        // Initial-Sync triggern
        kv.synchronize()

        // Externe Änderungen aus iCloud
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(externalChange(_:)),
            name: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: kv
        )
    }

    // ─── Sync-Helpers ────────────────────────────────────────
    private func sync(_ key: String, _ value: Any) {
        guard !applyingRemote else { return }
        ud.set(value, forKey: key)
        kv.set(value, forKey: key)
        // synchronize() ist async — iOS schreibt im Hintergrund. Kein expliziter Aufruf nötig.
    }

    private static func read(_ key: String, kv: NSUbiquitousKeyValueStore, ud: UserDefaults, default def: String) -> String {
        if let s = kv.string(forKey: key) { return s }
        if let s = ud.string(forKey: key) { return s }
        return def
    }

    private static func readBool(_ key: String, kv: NSUbiquitousKeyValueStore, ud: UserDefaults, default def: Bool) -> Bool {
        // KV-Store hat keinen "key existiert"-Test; object(forKey:) liefert nil wenn nicht gesetzt
        if kv.object(forKey: key) != nil { return kv.bool(forKey: key) }
        if ud.object(forKey: key) != nil { return ud.bool(forKey: key) }
        return def
    }

    // ─── Inbound: KV-Store hat sich extern geändert ──────────
    @objc private func externalChange(_ note: Notification) {
        Task { @MainActor in
            let changedKeys = (note.userInfo?[NSUbiquitousKeyValueStoreChangedKeysKey] as? [String]) ?? []
            applyingRemote = true
            defer { applyingRemote = false }
            for key in changedKeys {
                switch key {
                case "backendURL":     if let v = kv.string(forKey: key) { backendURL     = v }
                case "authUser":       if let v = kv.string(forKey: key) { authUser       = v }
                case "authPass":       if let v = kv.string(forKey: key) { authPass       = v }
                case "chatId":         if let v = kv.string(forKey: key) { chatId         = v }
                case "speakReplies":   speakReplies   = kv.bool(forKey: key)
                case "ttsBackend":     if let v = kv.string(forKey: key) { ttsBackend     = v }
                case "ttsVoiceID":     if let v = kv.string(forKey: key) { ttsVoiceID     = v }
                case "piperVoice":     if let v = kv.string(forKey: key) { piperVoice     = v }
                case "edgeVoice":      if let v = kv.string(forKey: key) { edgeVoice      = v }
                case "speakStreaming": speakStreaming = kv.bool(forKey: key)
                case "picovoiceAccessKey": if let v = kv.string(forKey: key) { picovoiceAccessKey = v }
                case "wakeWordEnabled": wakeWordEnabled = kv.bool(forKey: key)
                case "bargeInEnabled":  bargeInEnabled  = kv.bool(forKey: key)
                case "conversationMode": conversationMode = kv.bool(forKey: key)
                case "orbStyle":      if let v = kv.string(forKey: key) { orbStyle = v }
                case "particleShape": if let v = kv.string(forKey: key) { particleShape = v }
                default: break
                }
                // UserDefaults parallel aktualisieren
                if let obj = kv.object(forKey: key) { ud.set(obj, forKey: key) }
            }
        }
    }
}
