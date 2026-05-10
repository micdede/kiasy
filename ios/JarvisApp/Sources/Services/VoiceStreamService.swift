import Foundation
import AVFoundation

/// Echtzeit-Sprachdialog via WebSocket.
/// Record → Whisper STT → Agent → Piper-Audio-Streaming → AVAudioPlayerNode.
///
/// Kommunikation mit ContentView über @Published-Properties:
///   turnStarted    → ContentView hängt User-Bubble + leere Assistant-Bubble an
///   accumulatedText → ContentView aktualisiert Assistant-Bubble live
///   turnFinished   → ContentView finalisiert Bubble + setzt sending=false
@MainActor
final class VoiceStreamService: NSObject, ObservableObject {

    enum State: Equatable { case idle, listening, processing, speaking }

    @Published var state: State = .idle
    @Published var inputLevel: Float = 0
    @Published var outputLevel: Float = 0

    // Signale für ContentView (über .onChange beobachtet)
    @Published var turnStarted:      Int    = 0   // +1 wenn Transcript da ist
    @Published var latestTranscript: String = ""
    @Published var accumulatedText:  String = ""
    @Published var turnFinished:     Int    = 0   // +1 wenn done + Playback fertig

    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?

    // Recording via AVAudioRecorder (einfacher als AVAudioEngine für file-basiertes STT)
    private var recorder: AVAudioRecorder?
    private var recordURL: URL?
    private var meterTimer: Timer?

    // Playback via AVAudioEngine + AVAudioPlayerNode (chunk-by-chunk scheduling)
    private let playEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private var playFormat: AVAudioFormat?
    private var playRunning = false

    // MARK: - Connection

    func connect(settings: AppSettings) {
        guard webSocket == nil else { return }

        var urlStr = settings.backendURL
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
        stopRecording()
        stopPlayback()
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket  = nil
        urlSession = nil
        state = .idle
    }

    // MARK: - Listening

    func startListening() {
        guard state == .idle || state == .speaking else { return }
        stopPlayback()

        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.record, mode: .measurement)
            try s.setActive(true)
        } catch { print("[VoiceWS] record session: \(error)") }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis_\(Int(Date().timeIntervalSince1970)).wav")
        recordURL = tmp

        let recSettings: [String: Any] = [
            AVFormatIDKey:            Int(kAudioFormatLinearPCM),
            AVSampleRateKey:          16000.0,
            AVNumberOfChannelsKey:    1,
            AVLinearPCMBitDepthKey:   16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey:    false
        ]
        do {
            recorder = try AVAudioRecorder(url: tmp, settings: recSettings)
            recorder!.isMeteringEnabled = true
            recorder!.record()
            state = .listening
            startMeterTimer()
        } catch { print("[VoiceWS] recorder: \(error)") }
    }

    func stopListening() {
        guard state == .listening else { return }
        stopRecording()
        state = .processing
        sendRecording()
    }

    func stopAll() {
        sendWS(["type": "stop"])
        stopRecording()
        stopPlayback()
        state = .idle
    }

    private func stopRecording() {
        meterTimer?.invalidate(); meterTimer = nil
        recorder?.stop(); recorder = nil
        inputLevel = 0
    }

    private func sendRecording() {
        guard let url = recordURL, let wav = try? Data(contentsOf: url) else {
            state = .idle; return
        }
        try? FileManager.default.removeItem(at: url)
        recordURL = nil
        sendWS(["type": "audio", "data": wav.base64EncodedString()])
        print("[VoiceWS] sent \(wav.count) bytes")
    }

    private func startMeterTimer() {
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let rec = self.recorder, rec.isRecording else { return }
                rec.updateMeters()
                let dB = rec.averagePower(forChannel: 0)  // -160…0
                self.inputLevel = max(0, min(1, (dB + 60) / 60))
            }
        }
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

        // Grobe Pegelanzeige aus den ersten Samples
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

    /// Wartet via Sentinel-Buffer bis der PlayerNode alle Chunks abgespielt hat,
    /// dann idle + turnFinished signalisieren.
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
                print("[VoiceWS] receive: \(err.localizedDescription)")
                Task { @MainActor in
                    if self.state != .idle { self.state = .idle }
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
            let t = (obj["text"] as? String) ?? ""
            latestTranscript = t
            accumulatedText  = ""
            turnStarted += 1

        case "text_chunk":
            accumulatedText += (obj["text"] as? String) ?? ""

        case "audio_start":
            state = .speaking
            let fmt   = obj["format"] as? [String: Any]
            let rate  = (fmt?["rate"]     as? Double) ?? 22050
            let chans = AVAudioChannelCount((fmt?["channels"] as? Int) ?? 1)
            if let avFmt = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                         sampleRate: rate, channels: chans,
                                         interleaved: true) {
                startPlayEngine(format: avFmt)
            }

        case "audio_chunk":
            if let b64 = obj["data"] as? String, let pcm = Data(base64Encoded: b64) {
                scheduleChunk(pcm)
            }

        case "done":
            waitForPlaybackEnd()

        case "error":
            print("[VoiceWS] server: \(obj["message"] ?? "")")
            state = .idle

        default: break
        }
    }

    // MARK: - Send

    private func sendWS(_ dict: [String: Any]) {
        guard let ws  = webSocket,
              let d   = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: d, encoding: .utf8) else { return }
        ws.send(.string(str)) { err in
            if let err { print("[VoiceWS] send: \(err)") }
        }
    }
}
