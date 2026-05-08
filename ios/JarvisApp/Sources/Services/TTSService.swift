import Foundation
import AVFoundation

@MainActor
final class TTSService: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var isSpeaking: Bool = false

    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Findet die beste deutsche Stimme als Fallback wenn keine ID gesetzt ist.
    private func defaultVoice(language: String) -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(language) }
        return voices.first(where: { $0.quality == .premium })
            ?? voices.first(where: { $0.quality == .enhanced })
            ?? voices.first
            ?? AVSpeechSynthesisVoice(language: language)
    }

    /// voiceID = AVSpeechSynthesisVoice.identifier, leer/nil → Default-Stimme.
    func speak(_ text: String, voiceID: String? = nil, language: String = "de-DE") {
        let cleaned = stripMarkdown(text)
        guard !cleaned.isEmpty else { return }
        // .voicePrompt-Mode optimiert für Sprachausgabe + Speaker-Override
        // gegen das Earpiece-Routing nach .measurement-Aufnahme.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)
        } catch {
            print("[TTS] AudioSession-Setup fehlgeschlagen: \(error)")
        }

        let voice: AVSpeechSynthesisVoice? = {
            if let id = voiceID, !id.isEmpty, let v = AVSpeechSynthesisVoice(identifier: id) { return v }
            return defaultVoice(language: language)
        }()

        let utterance = AVSpeechUtterance(string: cleaned)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.0
        print("[TTS] speaking \(cleaned.count) chars, voice=\(voice?.identifier ?? "nil") name=\(voice?.name ?? "?")")
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
