import Foundation
import AVFoundation

@MainActor
final class AudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var currentLevel: Float = -160  // dB, für VAD-Anzeige

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var stopContinuation: CheckedContinuation<Data?, Never>?
    private var aborted = false

    enum RecorderError: LocalizedError {
        case permissionDenied
        case empty
        var errorDescription: String? {
            switch self {
            case .permissionDenied: return "Mikrofon-Zugriff verweigert (Systemeinstellungen → Datenschutz → Mikrofon)"
            case .empty: return "Aufnahme leer"
            }
        }
    }

    func requestPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined:
            return await withCheckedContinuation { cont in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    cont.resume(returning: granted)
                }
            }
        @unknown default: return false
        }
    }

    func start() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-rec-\(Int(Date().timeIntervalSince1970)).m4a")
        fileURL = url
        aborted = false
        currentLevel = -160

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        r.delegate = self
        r.isMeteringEnabled = true
        let ok = r.record()
        NSLog("[Jarvis] AudioRecorder.start record()=\(ok)")
        recorder = r
        isRecording = true
    }

    /// Stoppt die Aufnahme und gibt die fertige Audio-Datei zurück.
    /// Wartet via Delegate auf Datei-Finalisierung.
    func stop() async -> Data? {
        guard let rec = recorder else {
            isRecording = false
            return nil
        }
        return await withCheckedContinuation { cont in
            self.stopContinuation = cont
            rec.stop()
        }
    }

    /// Bricht eine laufende VAD-Schleife ab. stop() wird trotzdem aufgerufen, Daten verworfen.
    func abort() {
        aborted = true
    }

    /// Startet Aufnahme, beobachtet Mic-Pegel und stoppt automatisch nach Stille.
    /// - Returns: Aufnahme-Daten, oder nil wenn keine Sprache erkannt / abgebrochen.
    func recordWithVAD(
        silenceThreshold: Float = -35,
        silenceDuration: TimeInterval = 0.8,
        minSpeechDuration: TimeInterval = 0.25,
        maxDuration: TimeInterval = 30,
        speechTimeout: TimeInterval = 6
    ) async -> Data? {
        do {
            try start()
        } catch {
            return nil
        }

        let startTime = Date()
        var firstSpeechTime: Date?
        var lastSpeechTime: Date?

        loop: while isRecording && !aborted {
            try? await Task.sleep(nanoseconds: 100_000_000)  // 100ms Polling
            guard let r = recorder, isRecording, !aborted else { break }
            r.updateMeters()
            let level = r.averagePower(forChannel: 0)
            currentLevel = level
            let now = Date()
            let elapsed = now.timeIntervalSince(startTime)

            if level > silenceThreshold {
                if firstSpeechTime == nil { firstSpeechTime = now }
                lastSpeechTime = now
            }

            // Hard Stop nach Maximum
            if elapsed > maxDuration { break loop }

            // Wenn nach Timeout immer noch keine Sprache → kein Senden
            if firstSpeechTime == nil && elapsed > speechTimeout {
                _ = await stop()
                return nil
            }

            // Stille nach Sprache erkannt
            if let last = lastSpeechTime,
               let first = firstSpeechTime,
               last.timeIntervalSince(first) >= minSpeechDuration,
               now.timeIntervalSince(last) >= silenceDuration {
                break loop
            }
        }

        let data = await stop()
        if aborted { return nil }
        return data
    }
}

extension AudioRecorder: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            let data = self.fileURL.flatMap { try? Data(contentsOf: $0) }
            if let url = self.fileURL { try? FileManager.default.removeItem(at: url) }
            self.recorder = nil
            self.fileURL = nil
            self.isRecording = false
            self.currentLevel = -160
            self.stopContinuation?.resume(returning: data)
            self.stopContinuation = nil
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            self.recorder = nil
            self.fileURL = nil
            self.isRecording = false
            self.currentLevel = -160
            self.stopContinuation?.resume(returning: nil)
            self.stopContinuation = nil
        }
    }
}
