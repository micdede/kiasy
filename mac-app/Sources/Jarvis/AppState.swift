import Foundation
import SwiftUI
import AppKit

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
    @Published var hotkeyKeyCode: Int {
        didSet { UserDefaults.standard.set(hotkeyKeyCode, forKey: "hotkeyKeyCode") }
    }
    /// Rohwert von NSEvent.ModifierFlags (gemaskt auf Cmd/Opt/Ctrl/Shift)
    @Published var hotkeyModifiers: Int {
        didSet { UserDefaults.standard.set(hotkeyModifiers, forKey: "hotkeyModifiers") }
    }
    @Published var hotkeyEnabled: Bool {
        didSet { UserDefaults.standard.set(hotkeyEnabled, forKey: "hotkeyEnabled") }
    }
    @Published var dialogMode: Bool = false {
        didSet {
            if dialogMode == oldValue { return }
            if dialogMode { startDialog() } else { stopDialog() }
        }
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
        // Default: F13 (keyCode 105, kein Modifier)
        let kc = UserDefaults.standard.object(forKey: "hotkeyKeyCode") as? Int ?? 105
        let mod = UserDefaults.standard.object(forKey: "hotkeyModifiers") as? Int ?? 0
        let hkOn = UserDefaults.standard.object(forKey: "hotkeyEnabled") as? Bool ?? true
        self.serverURL = url
        self.username = user
        self.password = pass
        self.ttsEnabled = tts
        self.hotkeyKeyCode = kc
        self.hotkeyModifiers = mod
        self.hotkeyEnabled = hkOn
        if url.isEmpty || user.isEmpty || pass.isEmpty {
            self.showingSettings = true
        }
    }

    var hotkeyDisplay: String {
        let mods = NSEvent.ModifierFlags(rawValue: UInt(hotkeyModifiers))
        return KeyMapper.display(keyCode: hotkeyKeyCode, modifiers: mods)
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
            let result = try await client().send(message: text)
            if !result.text.isEmpty || !result.images.isEmpty {
                messages.append(ChatMessage(role: "assistant", text: result.text, images: result.images))
                if ttsEnabled, !result.text.isEmpty { await playTTS(result.text) }
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
        guard let data = await recorder.stop(), !data.isEmpty else {
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
            if !result.text.isEmpty || !result.images.isEmpty {
                messages.append(ChatMessage(role: "assistant", text: result.text, images: result.images))
                if ttsEnabled, !result.text.isEmpty { await playTTS(result.text) }
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func fetchImage(_ image: ChatImage) async throws -> Data {
        try await client().fetchImage(urlOrPath: image.url)
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

    // MARK: - Dialog Mode

    private func startDialog() {
        // Wenn TTS endet → nächster Listen-Cycle
        player.onFinish = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self = self, self.dialogMode else { return }
                // Kurze Pause, damit Mic nicht den TTS-Schwanz aufnimmt
                try? await Task.sleep(nanoseconds: 150_000_000)
                await self.dialogListenLoop()
            }
        }
        Task { await dialogListenLoop() }
    }

    private func stopDialog() {
        player.onFinish = nil
        player.stop()
        if recorder.isRecording { recorder.abort() }
    }

    private func dialogListenLoop() async {
        guard dialogMode, isConfigured, !isSending else { return }
        let data = await recorder.recordWithVAD()
        guard dialogMode else { return }
        guard let data = data, !data.isEmpty else {
            dialogMode = false
            return
        }
        isSending = true
        defer { isSending = false }

        // Pipeline: SSE-Stream → TTS-Tasks (parallel zur weiteren LLM-Antwort)
        // → Consumer awaitet in Reihenfolge → Player-Queue.
        // (makeStream ist macOS 14+, hier kompatible Variante für macOS 13.)
        var ttsTaskCont: AsyncStream<Task<Data, Error>>.Continuation!
        let ttsTaskStream = AsyncStream<Task<Data, Error>> { cont in ttsTaskCont = cont }

        let consumer = Task { @MainActor [weak self] in
            for await task in ttsTaskStream {
                guard let self = self, self.dialogMode else { task.cancel(); continue }
                do {
                    let audio = try await task.value
                    if !self.dialogMode { return }
                    self.player.enqueue(data: audio)
                } catch {
                    // einzelner TTS-Fehler → Satz überspringen, weitermachen
                }
            }
        }

        var assistantText = ""
        var assistantImages: [ChatImage] = []

        do {
            let net = client()
            for try await ev in net.sendVoiceStream(audioData: data) {
                guard dialogMode else { break }
                switch ev {
                case .transcript(let t):
                    if !t.isEmpty {
                        messages.append(ChatMessage(role: "user", text: t))
                    }
                case .sentence(let text, _):
                    let snippet = text
                    let task = Task { try await net.tts(text: snippet) }
                    ttsTaskCont.yield(task)
                case .toolUse:
                    break // optional: UI-Status zeigen
                case .discard:
                    player.stop()
                case .done(let text, let images):
                    assistantText = text
                    assistantImages = images
                case .streamError(let msg):
                    lastError = msg
                case .delta:
                    break
                }
            }
            if !assistantText.isEmpty || !assistantImages.isEmpty {
                messages.append(ChatMessage(role: "assistant", text: assistantText, images: assistantImages))
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }

        ttsTaskCont.finish()
        await consumer.value

        // Falls Player nichts mehr in Queue hat: direkt nächster Cycle
        // Sonst triggert player.onFinish den Cycle (in startDialog gesetzt)
        if !player.isPlaying && dialogMode {
            try? await Task.sleep(nanoseconds: 150_000_000)
            await dialogListenLoop()
        }
    }
}

struct ChatMessage: Identifiable, Hashable {
    let id = UUID()
    let role: String
    let text: String
    var images: [ChatImage] = []
}

struct ChatImage: Identifiable, Hashable {
    let id = UUID()
    let url: String     // relative ("/api/chat/images/...") oder absolute URL
    let caption: String
}
