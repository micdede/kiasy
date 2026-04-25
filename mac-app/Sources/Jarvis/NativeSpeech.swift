import Foundation
import Speech
import AVFoundation

// MARK: - On-Device STT via SFSpeechRecognizer

@MainActor
enum NativeSpeechRecognizer {
    enum SpeechError: LocalizedError {
        case unauthorized
        case unavailable
        case empty
        var errorDescription: String? {
            switch self {
            case .unauthorized: return "Spracherkennung nicht erlaubt (Systemeinstellungen → Datenschutz → Spracherkennung)"
            case .unavailable:  return "Spracherkennung für Deutsch nicht verfügbar"
            case .empty:        return "Keine Sprache erkannt"
            }
        }
    }

    static func requestAuthorization() async -> Bool {
        await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
    }

    /// Transkribiert eine Audiodatei (M4A/WAV) on-device, ohne Netz.
    /// Schneller als Whisper-Server-Roundtrip (~200-500ms vs ~1-2s).
    static func transcribe(fileURL: URL) async throws -> String {
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "de-DE")), rec.isAvailable else {
            throw SpeechError.unavailable
        }
        let req = SFSpeechURLRecognitionRequest(url: fileURL)
        req.shouldReportPartialResults = false
        if rec.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        return try await withCheckedThrowingContinuation { cont in
            rec.recognitionTask(with: req) { result, error in
                if let error = error {
                    cont.resume(throwing: error); return
                }
                guard let result = result, result.isFinal else { return }
                let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty {
                    cont.resume(throwing: SpeechError.empty)
                } else {
                    cont.resume(returning: text)
                }
            }
        }
    }
}

// MARK: - On-Device TTS via AVSpeechSynthesizer

@MainActor
final class NativeSpeechSynth: NSObject, ObservableObject {
    @Published var isSpeaking = false
    private let synth = AVSpeechSynthesizer()
    private var pending = 0

    /// Wird gefeuert, wenn die letzte Utterance natürlich endet (Queue leer).
    var onFinish: (() -> Void)?

    /// Sprechrate (0.5 = Standard 1.0 = Standard *2 — siehe AVSpeechUtterance.defaultRate).
    /// 1.05 ≈ leicht schneller als Default, harmoniert mit Edge-TTS-Vergleich.
    var rateMultiplier: Float = 1.05

    /// Bevorzugte Stimme per identifier — wird via AppState aus UserDefaults gesetzt.
    /// Wenn nil oder nicht installiert, fällt preferredVoice() auf Premium/Enhanced/Default zurück.
    var preferredVoiceIdentifier: String? = nil

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Reiht Text zum Sprechen ein. Beginnt sofort, wenn nichts läuft.
    func enqueue(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let utt = AVSpeechUtterance(string: trimmed)
        utt.voice = resolvedVoice()
        utt.rate = AVSpeechUtteranceDefaultSpeechRate * rateMultiplier
        utt.preUtteranceDelay = 0.0
        utt.postUtteranceDelay = 0.05
        pending += 1
        isSpeaking = true
        synth.speak(utt)
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
        pending = 0
        isSpeaking = false
    }

    private func resolvedVoice() -> AVSpeechSynthesisVoice? {
        if let id = preferredVoiceIdentifier,
           let v = AVSpeechSynthesisVoice(identifier: id) {
            return v
        }
        return Self.bestGermanVoice()
    }

    /// Best-effort-Default: Siri/Premium > Enhanced > Default.
    static func bestGermanVoice() -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("de") }
        if let v = voices.first(where: { $0.quality == .premium }) { return v }
        if let v = voices.first(where: { $0.quality == .enhanced }) { return v }
        return AVSpeechSynthesisVoice(language: "de-DE")
    }

    /// Alle deutschen installierten Stimmen, sortiert: Premium → Enhanced → Default,
    /// innerhalb der Stufe alphabetisch.
    static func germanVoices() -> [AVSpeechSynthesisVoice] {
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("de") }
        func rank(_ q: AVSpeechSynthesisVoiceQuality) -> Int {
            switch q {
            case .premium: return 0
            case .enhanced: return 1
            default: return 2
            }
        }
        return all.sorted { (a, b) in
            let ra = rank(a.quality), rb = rank(b.quality)
            if ra != rb { return ra < rb }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    /// Spielt einen kurzen Test-Satz ab — für den Probe-Button im Settings.
    func preview(text: String = "Hallo Michael, ich bin JARVIS.") {
        stop()
        let utt = AVSpeechUtterance(string: text)
        utt.voice = resolvedVoice()
        utt.rate = AVSpeechUtteranceDefaultSpeechRate * rateMultiplier
        pending += 1
        isSpeaking = true
        synth.speak(utt)
    }
}

extension AVSpeechSynthesisVoiceQuality {
    var label: String {
        switch self {
        case .premium: return "Premium"
        case .enhanced: return "Enhanced"
        default: return "Default"
        }
    }
}

extension NativeSpeechSynth: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.pending = max(0, self.pending - 1)
            if self.pending == 0 {
                self.isSpeaking = false
                self.onFinish?()
            }
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            self.pending = max(0, self.pending - 1)
            if self.pending == 0 {
                self.isSpeaking = false
            }
        }
    }
}
