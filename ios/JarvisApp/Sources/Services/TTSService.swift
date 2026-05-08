import Foundation
import AVFoundation

@MainActor
final class TTSService: NSObject, ObservableObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    @Published var isSpeaking: Bool = false

    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var piperTask: Task<Void, Never>?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    // ─── Public API ──────────────────────────────────────────
    /// Routet je nach settings.ttsBackend → iOS-Voice / Piper / Edge.
    func speak(_ text: String, settings: AppSettings) {
        let cleaned = stripMarkdown(text)
        guard !cleaned.isEmpty else { return }
        configurePlaybackSession()
        switch settings.ttsBackend {
        case "piper": speakServer(cleaned, engine: "piper", voice: settings.piperVoice, settings: settings)
        case "edge":  speakServer(cleaned, engine: "edge",  voice: settings.edgeVoice,  settings: settings)
        default:      speakIOS(cleaned, voiceID: settings.ttsVoiceID)
        }
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        audioPlayer?.stop()
        audioPlayer = nil
        piperTask?.cancel()
        piperTask = nil
        isSpeaking = false
    }

    // ─── Audio-Session ───────────────────────────────────────
    private func configurePlaybackSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
            try session.setActive(true)
            try session.overrideOutputAudioPort(.speaker)
        } catch {
            print("[TTS] AudioSession-Setup fehlgeschlagen: \(error)")
        }
    }

    // ─── iOS AVSpeechSynthesizer ─────────────────────────────
    private func defaultVoice(language: String) -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(language) }
        return voices.first(where: { $0.quality == .premium })
            ?? voices.first(where: { $0.quality == .enhanced })
            ?? voices.first
            ?? AVSpeechSynthesisVoice(language: language)
    }

    private func speakIOS(_ text: String, voiceID: String) {
        let voice: AVSpeechSynthesisVoice? = {
            if !voiceID.isEmpty, let v = AVSpeechSynthesisVoice(identifier: voiceID) { return v }
            return defaultVoice(language: "de-DE")
        }()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.0
        print("[TTS-iOS] speaking, voice=\(voice?.name ?? "?")")
        synthesizer.speak(utterance)
    }

    // ─── Server-TTS (engine = piper | edge) ──────────────────
    private func speakServer(_ text: String, engine: String, voice: String, settings: AppSettings) {
        piperTask?.cancel()
        piperTask = Task { [weak self] in
            guard let self else { return }
            do {
                let audio = try await self.fetchServerAudio(text: text, engine: engine, voice: voice, settings: settings)
                guard !Task.isCancelled else { return }
                try await MainActor.run {
                    let player = try AVAudioPlayer(data: audio)
                    player.delegate = self
                    self.audioPlayer = player
                    self.isSpeaking = true
                    print("[TTS-\(engine)] play \(audio.count) bytes")
                    player.play()
                }
            } catch {
                print("[TTS-\(engine)] Fehler: \(error.localizedDescription) — Fallback auf iOS-Stimme")
                await MainActor.run {
                    self.speakIOS(text, voiceID: settings.ttsVoiceID)
                }
            }
        }
    }

    private func fetchServerAudio(text: String, engine: String, voice: String, settings: AppSettings) async throws -> Data {
        guard let url = URL(string: "\(settings.backendURL)/api/voice/synth") else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !settings.authUser.isEmpty {
            let token = "\(settings.authUser):\(settings.authPass)".data(using: .utf8)!.base64EncodedString()
            req.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
        }
        var body: [String: Any] = ["text": text, "engine": engine]
        if !voice.isEmpty { body["voice"] = voice }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
            throw NSError(domain: "ServerTTS", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"])
        }
        return data
    }

    // ─── Markdown-Cleanup ────────────────────────────────────
    private func stripMarkdown(_ s: String) -> String {
        var t = s
        t = t.replacingOccurrences(of: "```[\\s\\S]*?```", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "`([^`]*)`", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "__([^_]+)__", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\*([^*]+)\\*", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "_([^_]+)_", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "(?m)^#+\\s*", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    // ─── Delegates ───────────────────────────────────────────
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = true }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
