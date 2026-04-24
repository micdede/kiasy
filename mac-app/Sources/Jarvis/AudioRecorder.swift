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
        recorder?.stop()
        recorder = nil
        isRecording = false
        guard let url = fileURL else { return nil }
        let data = try? Data(contentsOf: url)
        try? FileManager.default.removeItem(at: url)
        fileURL = nil
        return data
    }
}
