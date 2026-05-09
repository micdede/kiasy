import Foundation
import Porcupine

/// Always-On Wake-Word-Detector via Picovoice Porcupine.
///
/// Nutzt das eingebaute Built-in-Keyword `.jarvis` (kein eigenes Training nötig).
/// Detection feuert den `onDetected`-Callback auf der MainActor.
///
/// Lifecycle:
/// - `configure(accessKey:)` legt den Manager an (idempotent — bei gleichem Key no-op)
/// - `start()` beginnt das Hören (≈5% CPU)
/// - `stop()` stoppt das Hören (z.B. wenn Mic für SpeechService gebraucht wird)
/// - `shutdown()` gibt Porcupine frei (z.B. wenn AccessKey geändert oder Wake-Word aus)
///
/// Audio-Konflikt: Porcupine setzt selbst eine `.playAndRecord, .voiceChat`-Session.
/// Solange wir Wake stoppen wenn der SpeechService startet (Mic-Konflikt), passt das.
/// Während TTS spricht darf Wake weiterlaufen — Speaker-Output ist eine andere Route.
@MainActor
final class WakeWordService: ObservableObject {
    enum Status: Equatable {
        case idle              // nicht initialisiert (kein Key oder Wake aus)
        case ready             // konfiguriert, nicht aktiv
        case listening         // hört
        case error(String)     // letzter Versuch ist gescheitert
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var lastDetectedAt: Date?

    /// Wird aufgerufen wenn das Wake-Word erkannt wurde (auf MainActor).
    var onDetected: (() -> Void)?

    private var manager: PorcupineManager?
    private var configuredKey: String?

    /// Initialisiert (oder re-initialisiert bei Key-Change) den PorcupineManager.
    /// Stoppt das Hören vorher — `start()` muss separat aufgerufen werden.
    func configure(accessKey: String) {
        let key = accessKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            shutdown()
            status = .idle
            return
        }
        // Bereits mit demselben Key konfiguriert → nichts zu tun
        if configuredKey == key, manager != nil { return }

        // Alten Manager freigeben
        shutdown()

        do {
            let mgr = try PorcupineManager(
                accessKey: key,
                keyword: .jarvis,
                onDetection: { [weak self] _ in
                    Task { @MainActor in
                        guard let self else { return }
                        self.lastDetectedAt = Date()
                        print("[WakeWord] Jarvis erkannt")
                        self.onDetected?()
                    }
                }
            )
            self.manager = mgr
            self.configuredKey = key
            self.status = .ready
            print("[WakeWord] PorcupineManager konfiguriert")
        } catch {
            self.manager = nil
            self.configuredKey = nil
            self.status = .error(friendlyMessage(error))
            print("[WakeWord] configure fehlgeschlagen: \(error)")
        }
    }

    func start() {
        guard let mgr = manager else {
            // Nicht konfiguriert → kein Fehler, einfach idle bleiben
            return
        }
        if case .listening = status { return }
        do {
            try mgr.start()
            status = .listening
            print("[WakeWord] gestartet")
        } catch {
            status = .error(friendlyMessage(error))
            print("[WakeWord] start fehlgeschlagen: \(error)")
        }
    }

    func stop() {
        guard let mgr = manager else { return }
        do {
            try mgr.stop()
            if case .listening = status { status = .ready }
            print("[WakeWord] gestoppt")
        } catch {
            print("[WakeWord] stop fehlgeschlagen: \(error)")
        }
    }

    /// Gibt Porcupine vollständig frei (z.B. bei AccessKey-Wechsel).
    func shutdown() {
        if let mgr = manager {
            try? mgr.stop()
            mgr.delete()
        }
        manager = nil
        configuredKey = nil
        status = .idle
    }

    private func friendlyMessage(_ error: Error) -> String {
        let raw = String(describing: error)
        if raw.contains("invalid AccessKey") || raw.contains("Invalid AccessKey") {
            return "AccessKey ungültig — auf https://console.picovoice.ai prüfen"
        }
        if raw.contains("AccessKey") && raw.contains("limit") {
            return "AccessKey-Limit erreicht (Free-Plan: 3 Geräte)"
        }
        return error.localizedDescription
    }
}
