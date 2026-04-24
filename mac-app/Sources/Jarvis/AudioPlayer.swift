import Foundation
import AVFoundation

@MainActor
final class AudioPlayer: NSObject, ObservableObject {
    @Published var isPlaying = false
    private var player: AVAudioPlayer?

    /// Wird gefeuert, wenn die Wiedergabe natürlich endet (nicht bei stop()).
    var onFinish: (() -> Void)?

    func play(data: Data) throws {
        stop()
        let p = try AVAudioPlayer(data: data)
        p.delegate = self
        p.prepareToPlay()
        p.play()
        player = p
        isPlaying = true
    }

    func stop() {
        player?.stop()
        player = nil
        isPlaying = false
    }
}

extension AudioPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
            self.player = nil
            self.onFinish?()
        }
    }
}
