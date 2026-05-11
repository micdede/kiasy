import Foundation
import AVFoundation

/// WebSocket-TTS-Empfänger für Echtzeit-Sprachdialog.
///
/// STT + Stille-Erkennung übernimmt weiterhin SpeechService (on-device,
/// kein Whisper-Overhead). VoiceStreamService ist nur für den TTS-Rückkanal:
///   - sendText()    → schickt transkribierten Text an Server
///   - audio_start   → richtet AVAudioPlayerNode ein
///   - audio_chunk   → schedulet PCM-Buffer direkt
///   - done          → wechselt nach Playback-Ende auf .idle
///
/// Kommunikation mit ContentView über @Published-Properties:
///   turnStarted     → ContentView hängt User-Bubble + leere Assistant-Bubble an
///   accumulatedText → ContentView aktualisiert Assistant-Bubble live
///   turnFinished    → ContentView finalisiert Bubble + setzt sending=false
@MainActor
final class VoiceStreamService: NSObject, ObservableObject {

    enum State: Equatable { case idle, processing, speaking }

    @Published var state: State = .idle
    @Published var outputLevel: Float = 0

    // Signale für ContentView (über .onChange beobachtet)
    @Published var turnStarted:      Int    = 0
    @Published var latestTranscript: String = ""
    @Published var accumulatedText:  String = ""
    @Published var turnFinished:     Int    = 0

    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?

    // Timing
    private var t0: Date = Date()
    private var firstTextChunk = false
    private var firstAudioChunk = false
    private func ms() -> String { String(format: "%.0fms", Date().timeIntervalSince(t0) * 1000) }

    // Playback via AVAudioEngine + AVAudioPlayerNode
    private let playEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var playFormat: AVAudioFormat?
    private var playRunning = false

    // MARK: - Connection

    func connect(settings: AppSettings) {
        guard webSocket == nil else { return }

        var urlStr = settings.baseURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://",  with: "ws://")
        urlStr += "/ws/voice?chatId=ios-realtime"
        guard let url = URL(string: urlStr) else { return }

        var req = URLRequest(url: url)
        if !settings.authUser.isEmpty {
            let tok = "\(settings.authUser):\(settings.authPass)"
                .data(using: .utf8)!.base64EncodedString()
            req.setValue("Basic \(tok)", forHTTPHeaderField: "Authorization")
        }

        urlSession = URLSession(configuration: .default)
        webSocket  = urlSession!.webSocketTask(with: req)
        webSocket!.resume()
        receiveLoop()
        print("[VoiceWS] connected \(urlStr)")
    }

    func disconnect() {
        stopPlayback()
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket  = nil
        urlSession = nil
        state = .idle
    }

    // MARK: - Send

    /// Schickt transkribierten Text an den Server (kein Whisper-Overhead).
    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        t0 = Date()
        firstTextChunk  = false
        firstAudioChunk = false
        latestTranscript = text
        accumulatedText  = ""
        turnStarted += 1
        state = .processing
        sendWS(["type": "text", "text": text])
        print("[VoiceWS] ⏱ T=0ms text sent: \"\(text.prefix(50))\"")
    }

    func cancelTurn() {
        sendWS(["type": "stop"])
        stopPlayback()
        state = .idle
    }

    // MARK: - Playback

    private func startPlayEngine(format: AVAudioFormat) {
        stopPlayback()
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
            try s.setActive(true)
            try? s.overrideOutputAudioPort(.speaker)
        } catch { print("[VoiceWS] play session: \(error)") }

        playEngine.attach(playerNode)
        playEngine.connect(playerNode, to: playEngine.mainMixerNode, format: format)
        do {
            try playEngine.start()
            playerNode.play()
            playRunning = true
            playFormat  = format
        } catch { print("[VoiceWS] play engine: \(error)") }
    }

    private func scheduleChunk(_ pcm: Data) {
        guard let fmt = playFormat, playRunning else { return }
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard frames > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
        buf.frameLength = frames
        pcm.withUnsafeBytes { ptr in
            guard let src = ptr.baseAddress?.assumingMemoryBound(to: Int16.self),
                  let dst = buf.int16ChannelData?[0] else { return }
            dst.update(from: src, count: Int(frames))
        }
        playerNode.scheduleBuffer(buf)

        let n = min(256, Int(frames))
        let lvl = pcm.withUnsafeBytes { ptr -> Float in
            guard let p = ptr.baseAddress?.assumingMemoryBound(to: Int16.self) else { return 0 }
            var s: Float = 0
            for i in 0..<n { s += Float(abs(p[i])) }
            return min(1, s / Float(n) / 16384)
        }
        outputLevel = max(outputLevel * 0.85, lvl)
    }

    func stopPlayback() {
        guard playRunning else { return }
        playerNode.stop()
        playEngine.stop()
        playEngine.detach(playerNode)
        playRunning = false
        playFormat  = nil
        outputLevel = 0
    }

    private func waitForPlaybackEnd() {
        guard let fmt = playFormat, playRunning else { finishTurn(); return }
        guard let sentinel = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 1) else {
            finishTurn(); return
        }
        sentinel.frameLength = 0
        playerNode.scheduleBuffer(sentinel, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in self?.finishTurn() }
        }
    }

    private func finishTurn() {
        print("[VoiceWS] ⏱ T=\(ms()) playback complete — full turn done")
        stopPlayback()
        state = .idle
        turnFinished += 1
    }

    // MARK: - WebSocket Receive

    private func receiveLoop() {
        webSocket?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                if case .string(let s) = msg {
                    Task { @MainActor in self.handle(s) }
                }
                self.receiveLoop()
            case .failure(let err):
                print("[VoiceWS] receive error: \(err.localizedDescription)")
                // Socket tot → aufräumen damit reconnect möglich ist
                Task { @MainActor in
                    self.stopPlayback()
                    self.webSocket  = nil
                    self.urlSession = nil
                    self.state = .idle
                }
            }
        }
    }

    private func handle(_ json: String) {
        guard let d    = json.data(using: .utf8),
              let obj  = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let type = obj["type"] as? String else { return }

        switch type {

        case "transcript":
            // Im text-Modus kommt kein transcript vom Server — ignorieren
            break

        case "text_chunk":
            if !firstTextChunk {
                firstTextChunk = true
                print("[VoiceWS] ⏱ T=\(ms()) first text_chunk")
            }
            accumulatedText += (obj["text"] as? String) ?? ""

        case "audio_start":
            state = .speaking
            let fmt   = obj["format"] as? [String: Any]
            let rate  = (fmt?["rate"]     as? Double) ?? 22050
            let chans = AVAudioChannelCount((fmt?["channels"] as? Int) ?? 1)
            print("[VoiceWS] ⏱ T=\(ms()) audio_start (\(Int(rate))Hz, \(chans)ch)")
            if let avFmt = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                         sampleRate: rate, channels: chans,
                                         interleaved: true) {
                startPlayEngine(format: avFmt)
            }

        case "audio_chunk":
            if let b64 = obj["data"] as? String, let pcm = Data(base64Encoded: b64) {
                if !firstAudioChunk {
                    firstAudioChunk = true
                    print("[VoiceWS] ⏱ T=\(ms()) first audio_chunk (\(pcm.count) bytes PCM) → playback starts")
                }
                scheduleChunk(pcm)
            }

        case "done":
            print("[VoiceWS] ⏱ T=\(ms()) done received, waiting for playback end")
            waitForPlaybackEnd()

        case "error":
            print("[VoiceWS] server: \(obj["message"] ?? "")")
            state = .idle

        default: break
        }
    }

    // MARK: - Helpers

    private func sendWS(_ dict: [String: Any]) {
        guard let ws  = webSocket,
              let d   = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: d, encoding: .utf8) else { return }
        ws.send(.string(str)) { err in
            if let err { print("[VoiceWS] send: \(err)") }
        }
    }
}
