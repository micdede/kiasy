import Foundation
import Speech
import AVFoundation

@MainActor
final class SpeechService: NSObject, ObservableObject {
    @Published var transcript: String = ""
    @Published var isListening: Bool = false
    @Published var permissionDenied: Bool = false
    @Published var lastError: String?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "de-DE"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    /// Timer der nach silenceTimeout Sekunden ohne neuen Recognizer-Output stop() ruft.
    /// Wird bei jedem Recognizer-Update reset. Genutzt im Konversations-Modus damit
    /// das Mic nicht ewig offen bleibt wenn der User nichts sagt.
    private var silenceTask: Task<Void, Never>?

    func requestPermissions() async -> Bool {
        let speechStatus = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        let micStatus = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
        let ok = speechStatus == .authorized && micStatus
        permissionDenied = !ok
        return ok
    }

    /// Startet die Aufnahme. `silenceTimeout` (in Sekunden) stoppt das Mic automatisch wenn
    /// der Recognizer für so lange keinen neuen Output liefert (für Konversations-Modus).
    /// `nil` = kein Auto-Stop, manuell oder via isFinal vom Recognizer.
    func start(silenceTimeout: TimeInterval? = nil) {
        guard !isListening else { return }
        guard let recognizer, recognizer.isAvailable else {
            lastError = "Recognizer nicht verfügbar"
            return
        }
        transcript = ""
        lastError = nil

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                req.requiresOnDeviceRecognition = true
            }
            self.request = req

            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                req.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()
            isListening = true

            // Silence-Timer: feuert wenn so lange kein Recognizer-Update kommt
            if let timeout = silenceTimeout {
                scheduleSilenceTimeout(timeout)
            }

            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                guard let self else { return }
                Task { @MainActor in
                    if let result {
                        self.transcript = result.bestTranscription.formattedString
                        // Recognizer hat geliefert → Silence-Timer reset
                        if let timeout = silenceTimeout {
                            self.scheduleSilenceTimeout(timeout)
                        }
                    }
                    if error != nil || (result?.isFinal ?? false) {
                        self.stop()
                    }
                }
            }
        } catch {
            lastError = error.localizedDescription
            stop()
        }
    }

    private func scheduleSilenceTimeout(_ seconds: TimeInterval) {
        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.stop() }
        }
    }

    func stop() {
        silenceTask?.cancel()
        silenceTask = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.finish()
        request = nil
        task = nil
        isListening = false
        // AudioSession deaktivieren, sonst blockiert sie TTS
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
