import Foundation
import AVFoundation

@MainActor
final class AudioPlayer: NSObject, ObservableObject {
    @Published var isPlaying = false
    private var player: AVAudioPlayer?

    /// FIFO-Queue für sequentielle Wiedergabe (z.B. satzweise TTS aus Stream).
    private var queue: [Data] = []

    /// Wird gefeuert, wenn die Wiedergabe natürlich endet UND Queue leer ist.
    var onFinish: (() -> Void)?

    /// Single-Shot-Wiedergabe — bricht laufende Wiedergabe und leert Queue.
    func play(data: Data) throws {
        stop()
        try startPlayback(data: data)
    }

    /// Reiht Audio ein. Spielt sofort, wenn nichts läuft.
    func enqueue(data: Data) {
        queue.append(data)
        if player == nil {
            playNextInQueue()
        }
    }

    func stop() {
        player?.stop()
        player = nil
        queue.removeAll()
        isPlaying = false
    }

    private func playNextInQueue() {
        guard !queue.isEmpty else {
            isPlaying = false
            onFinish?()
            return
        }
        let next = queue.removeFirst()
        do {
            try startPlayback(data: next)
        } catch {
            playNextInQueue()
        }
    }

    private func startPlayback(data: Data) throws {
        let p = try AVAudioPlayer(data: data)
        p.delegate = self
        p.prepareToPlay()
        p.play()
        player = p
        isPlaying = true
    }
}

extension AudioPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.player = nil
            self.playNextInQueue()
        }
    }
}
