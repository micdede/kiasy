import Foundation
import AVFoundation

@MainActor
final class AudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var stopContinuation: CheckedContinuation<Data?, Never>?

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

    /// Stoppt und gibt die aufgezeichneten Bytes zurück.
    /// Wartet via Delegate auf vollständige Datei-Finalisierung.
    func stop() async -> Data? {
        guard let rec = recorder else {
            isRecording = false
            return nil
        }
        return await withCheckedContinuation { cont in
            self.stopContinuation = cont
            rec.stop()
            // audioRecorderDidFinishRecording feuert, sobald die Datei geschlossen ist.
        }
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
            self.stopContinuation?.resume(returning: data)
            self.stopContinuation = nil
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            self.recorder = nil
            self.fileURL = nil
            self.isRecording = false
            self.stopContinuation?.resume(returning: nil)
            self.stopContinuation = nil
        }
    }
}
