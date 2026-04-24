import Foundation
import AVFoundation

@MainActor
final class AudioRecorder: NSObject, ObservableObject {
    @Published var isRecording = false

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?

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
        recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder?.record()
        isRecording = true
    }

    /// Stoppt und gibt die aufgezeichneten Bytes zurück.
    func stop() -> Data? {
        guard let rec = recorder, let url = fileURL else {
            isRecording = false
            return nil
        }
        rec.stop()
        // AVAudioRecorder finalisiert die Datei asynchron — kurz warten und Größe prüfen.
        var data: Data?
        for _ in 0..<20 {
            if let d = try? Data(contentsOf: url), d.count > 1024 {
                data = d
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if data == nil {
            data = try? Data(contentsOf: url)
        }
        recorder = nil
        isRecording = false
        try? FileManager.default.removeItem(at: url)
        fileURL = nil
        return data
    }
}
