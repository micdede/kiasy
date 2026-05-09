import Foundation
import AVFoundation

@MainActor
final class TTSService: NSObject, ObservableObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    @Published var isSpeaking: Bool = false
    /// 0...1 — TTS-Lautstärke für Visualisierung. Bei AVAudioPlayer (Piper/Edge) aus
    /// averagePower ermittelt, beim AVSpeechSynthesizer (iOS-Voice) ein synthetischer
    /// Sinus-Puls (kein direkter Pegel verfügbar).
    @Published var outputLevel: Float = 0

    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var piperTask: Task<Void, Never>?
    private var meterTask: Task<Void, Never>?
    /// Queue für sequentielle Speak-Aufrufe (für Streaming-TTS — Satz für Satz).
    /// `isSpeaking` bleibt true solange noch was in der Queue ist.
    private var speechQueue: [(text: String, settings: AppSettings)] = []

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    // ─── Public API ──────────────────────────────────────────
    /// Routet je nach settings.ttsBackend → iOS-Voice / Piper / Edge.
    func speak(_ text: String, settings: AppSettings) {
        let cleaned = stripMarkdown(text)
        guard !cleaned.isEmpty else { return }
        // Single-shot: bricht laufende Wiedergabe + Queue ab und spielt nur diesen Text
        speechQueue.removeAll()
        startSpeaking(cleaned, settings: settings)
    }

    /// Reiht einen Text in die Wiedergabe-Queue ein. Wenn nichts läuft, startet
    /// sofort. Sonst wird der Text nach dem aktuellen abgespielt. `isSpeaking`
    /// bleibt true bis die ganze Queue durch ist (wichtig für Konversations-Modus
    /// Auto-Continue-Trigger).
    func enqueueSpeak(_ text: String, settings: AppSettings) {
        let cleaned = stripMarkdown(text)
        guard !cleaned.isEmpty else { return }
        if isSpeaking {
            speechQueue.append((cleaned, settings))
        } else {
            startSpeaking(cleaned, settings: settings)
        }
    }

    private func startSpeaking(_ text: String, settings: AppSettings) {
        // SOFORT isSpeaking=true — sonst läuft der nächste enqueueSpeak direkt
        // wieder in startSpeaking statt in die Queue (während die async Synth
        // noch ~1s läuft, isSpeaking erst spät true wird). Race-Condition,
        // die zu parallelen TTS-Calls + Cancellation-Chaos geführt hat.
        isSpeaking = true
        configurePlaybackSession()
        switch settings.ttsBackend {
        case "piper": speakServer(text, engine: "piper", voice: settings.piperVoice, settings: settings)
        case "edge":  speakServer(text, engine: "edge",  voice: settings.edgeVoice,  settings: settings)
        default:      speakIOS(text, voiceID: settings.ttsVoiceID)
        }
    }

    /// Vom Delegate aufgerufen wenn ein Audio-Item fertig ist. Spielt den nächsten
    /// Eintrag aus der Queue oder beendet `isSpeaking`.
    private func processNextOrFinish() {
        if let next = speechQueue.first {
            speechQueue.removeFirst()
            startSpeaking(next.text, settings: next.settings)
        } else {
            isSpeaking = false
            stopMetering()
        }
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        audioPlayer?.stop()
        audioPlayer = nil
        piperTask?.cancel()
        piperTask = nil
        speechQueue.removeAll()
        stopMetering()
        isSpeaking = false
    }

    // ─── Audio-Level-Metering (für OrbView) ──────────────────
    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 50_000_000)  // 20 Hz
                await MainActor.run {
                    guard let self else { return }
                    if let p = self.audioPlayer, p.isPlaying {
                        p.updateMeters()
                        let dB = p.averagePower(forChannel: 0)  // -160 ... 0 dBFS
                        // Nutzbarer Bereich ab ~-50 dB (alles darunter ist Stille)
                        self.outputLevel = max(0, min(1, (dB + 50) / 50))
                    } else if self.synthesizer.isSpeaking {
                        // AVSpeechSynthesizer liefert keine Pegel — synthetischer Puls
                        let t = Date().timeIntervalSinceReferenceDate
                        self.outputLevel = Float((sin(t * 4) + 1) * 0.3 + 0.2)
                    } else {
                        self.outputLevel = 0
                    }
                }
            }
        }
    }

    private func stopMetering() {
        meterTask?.cancel()
        meterTask = nil
        outputLevel = 0
    }

    // ─── Audio-Session ───────────────────────────────────────
    private func configurePlaybackSession() {
        let session = AVAudioSession.sharedInstance()
        // Category + Mode setzen (idempotent, schnell)
        do {
            try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        } catch {
            print("[TTS] setCategory fehlgeschlagen: \(error)")
        }
        // Aktivieren (kann -50 werfen wenn STT-Session noch nicht released — egal, Audio spielt)
        do {
            try session.setActive(true)
        } catch {
            print("[TTS] setActive fehlgeschlagen (harmlos, Player spielt trotzdem): \(error.localizedDescription)")
        }
        // Speaker-Override nur wenn Category .playback ist (sonst wirft's -50)
        if session.category == .playback {
            try? session.overrideOutputAudioPort(.speaker)
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
        startMetering()
    }

    // ─── Server-TTS (engine = piper | edge) ──────────────────
    private func speakServer(_ text: String, engine: String, voice: String, settings: AppSettings) {
        // KEIN piperTask?.cancel() hier — die Queue-Logik garantiert dass
        // startSpeaking nur dann läuft wenn nichts anderes läuft. Cancellation
        // kommt nur durch User-Stop (stop() macht das selbst).
        piperTask = Task { [weak self] in
            guard let self else { return }
            do {
                let audio = try await self.fetchServerAudio(text: text, engine: engine, voice: voice, settings: settings)
                guard !Task.isCancelled else { return }
                try await MainActor.run {
                    let player = try AVAudioPlayer(data: audio)
                    player.delegate = self
                    player.isMeteringEnabled = true
                    self.audioPlayer = player
                    print("[TTS-\(engine)] play \(audio.count) bytes")
                    player.play()
                    self.startMetering()
                }
            } catch is CancellationError {
                return  // User-Stop, stop() hat aufgeräumt
            } catch let error as URLError where error.code == .cancelled {
                return
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
        Task { @MainActor in self.processNextOrFinish() }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // Cancel = User-Stop: nicht weiter mit Queue (die ist eh schon gecleart in stop())
        Task { @MainActor in
            if self.speechQueue.isEmpty {
                self.isSpeaking = false
                self.stopMetering()
            } else {
                self.processNextOrFinish()
            }
        }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.processNextOrFinish() }
    }
}
