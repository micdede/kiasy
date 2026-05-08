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
        guard !text.isEmpty else { return }
        // AudioSession nach Sprachaufnahme oft noch in .playAndRecord (Earpiece-
        // Routing). Für TTS auf .playback umschalten, damit es laut über
        // Lautsprecher kommt.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true, options: [])
        } catch {
            print("[TTS] AudioSession-Setup fehlgeschlagen: \(error)")
        }

        if voiceIdentifier == nil { setVoice(language: language) }
        let utterance = AVSpeechUtterance(string: text)
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
