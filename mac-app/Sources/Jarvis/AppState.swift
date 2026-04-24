import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var username: String {
        didSet { UserDefaults.standard.set(username, forKey: "username") }
    }
    @Published var password: String {
        didSet { try? Keychain.set(password, account: "monitor") }
    }
    @Published var ttsEnabled: Bool {
        didSet { UserDefaults.standard.set(ttsEnabled, forKey: "ttsEnabled") }
    }

    @Published var messages: [ChatMessage] = []
    @Published var isSending = false
    @Published var lastError: String? = nil
    @Published var showingSettings = false

    @Published var recorder = AudioRecorder()
    @Published var player = AudioPlayer()

    init() {
        let url = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        let user = UserDefaults.standard.string(forKey: "username") ?? ""
        let pass = (try? Keychain.get(account: "monitor")) ?? ""
        let tts = UserDefaults.standard.object(forKey: "ttsEnabled") as? Bool ?? false
        self.serverURL = url
        self.username = user
        self.password = pass
        self.ttsEnabled = tts
        if url.isEmpty || user.isEmpty || pass.isEmpty {
            self.showingSettings = true
        }
    }

    var isConfigured: Bool {
        !serverURL.isEmpty && !username.isEmpty && !password.isEmpty
    }

    private func client() -> Networking {
        Networking(serverURL: serverURL, username: username, password: password)
    }

    // MARK: - Text

    func loadHistory() async {
        guard isConfigured else { return }
        do {
            messages = try await client().fetchHistory()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func send(_ text: String) async {
        guard isConfigured, !text.isEmpty else { return }
        messages.append(ChatMessage(role: "user", text: text))
        isSending = true
        defer { isSending = false }
        do {
            let reply = try await client().send(message: text)
            if !reply.isEmpty {
                messages.append(ChatMessage(role: "assistant", text: reply))
                if ttsEnabled { await playTTS(reply) }
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            messages.append(ChatMessage(role: "assistant", text: "⚠️ \(error.localizedDescription)"))
        }
    }

    func clear() async {
        guard isConfigured else { return }
        do {
            try await client().clearHistory()
            messages = []
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Voice

    func startRecording() async {
        let granted = await recorder.requestPermission()
        guard granted else {
            lastError = AudioRecorder.RecorderError.permissionDenied.localizedDescription
            return
        }
        do {
            try recorder.start()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func stopRecordingAndSend() async {
        guard let data = recorder.stop(), !data.isEmpty else {
            lastError = AudioRecorder.RecorderError.empty.localizedDescription
            return
        }
        guard isConfigured else { return }
        isSending = true
        defer { isSending = false }
        do {
            let result = try await client().sendVoice(audioData: data)
            if !result.transcript.isEmpty {
                messages.append(ChatMessage(role: "user", text: result.transcript))
            }
            if !result.text.isEmpty {
                messages.append(ChatMessage(role: "assistant", text: result.text))
                if ttsEnabled { await playTTS(result.text) }
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - TTS

    func playTTS(_ text: String) async {
        guard isConfigured else { return }
        do {
            let data = try await client().tts(text: text)
            try player.play(data: data)
        } catch {
            lastError = "TTS: \(error.localizedDescription)"
        }
    }

    func stopTTS() {
        player.stop()
    }
}

struct ChatMessage: Identifiable, Hashable {
    let id = UUID()
    let role: String
    let text: String
}
