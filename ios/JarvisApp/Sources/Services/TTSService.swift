import Foundation
import AVFoundation

@MainActor
final class TTSService: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var isSpeaking: Bool = false

    private let synthesizer = AVSpeechSynthesizer()
    private var voiceIdentifier: String?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func setVoice(language: String) {
        // bevorzugt eine "enhanced" oder "premium" deutsche Stimme, sonst Default
        let voices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(language) }
        let preferred = voices.first(where: { $0.quality == .premium })
                     ?? voices.first(where: { $0.quality == .enhanced })
                     ?? voices.first
        voiceIdentifier = preferred?.identifier
    }

    func speak(_ text: String, language: String = "de-DE") {
        let cleaned = stripMarkdown(text)
        guard !cleaned.isEmpty else { return }
        // Frische Playback-Session — minimal, ohne Mode/Options, vermeidet
        // IPCAUClient-Konflikt mit der vorher aktiven Record-Session.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback)
            try session.setActive(true)
        } catch {
            print("[TTS] AudioSession-Setup fehlgeschlagen: \(error)")
        }

        if voiceIdentifier == nil { setVoice(language: language) }
        let utterance = AVSpeechUtterance(string: cleaned)
        if let id = voiceIdentifier, let v = AVSpeechSynthesisVoice(identifier: id) {
            utterance.voice = v
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: language)
        }
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.0
        print("[TTS] speaking \(text.count) chars, voice=\(utterance.voice?.identifier ?? "default")")
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    private func stripMarkdown(_ s: String) -> String {
        var t = s
        // Code-Blöcke ``` und Inline-Code `…`
        t = t.replacingOccurrences(of: "```[\\s\\S]*?```", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "`([^`]*)`", with: "$1", options: .regularExpression)
        // Bold/italic ** __ * _
        t = t.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "__([^_]+)__", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\*([^*]+)\\*", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "_([^_]+)_", with: "$1", options: .regularExpression)
        // Links [text](url) → text
        t = t.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        // Headings # ## ###
        t = t.replacingOccurrences(of: "(?m)^#+\\s*", with: "", options: .regularExpression)
        // Mehrere Whitespaces zusammenfassen
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = true }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
