import SwiftUI

struct ContentView: View {
    @EnvironmentObject var settings: AppSettings
    @StateObject private var speech = SpeechService()
    @StateObject private var tts = TTSService()
    @State private var messages: [ChatMessage] = []
    @State private var pending: ChatMessage? = nil
    @State private var sending = false
    @State private var showSettings = false
    @State private var statusText = "bereit"

    private let api = JarvisAPI()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                statusBar
                messagesList
                inputBar
            }
            .navigationTitle("JARVIS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task { _ = await speech.requestPermissions() }
        }
    }

    // MARK: - Subviews

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)
            Text(statusText)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Spacer()
            if speech.isListening {
                Text(speech.transcript.isEmpty ? "höre zu…" : speech.transcript)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(.tint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(messages) { msg in
                        MessageBubble(msg: msg)
                            .id(msg.id)
                    }
                }
                .padding(12)
            }
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 12) {
            Button {
                Task { await toggleListening() }
            } label: {
                Image(systemName: speech.isListening ? "stop.circle.fill" : "mic.circle.fill")
                    .resizable()
                    .frame(width: 64, height: 64)
                    .foregroundStyle(speech.isListening ? .red : .tint)
            }
            .disabled(sending)

            VStack(alignment: .leading, spacing: 2) {
                Text(speech.isListening ? "Loslassen / Stop drücken" : "Halte zum Sprechen")
                    .font(.subheadline)
                Text(sending ? "JARVIS denkt…" : (tts.isSpeaking ? "spricht…" : "tippe oder sprich"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if tts.isSpeaking {
                Button { tts.stop() } label: { Image(systemName: "speaker.slash.fill").foregroundStyle(.orange) }
            }
        }
        .padding(12)
        .background(.ultraThinMaterial)
    }

    private var statusColor: Color {
        if sending { return .orange }
        if tts.isSpeaking { return .blue }
        if speech.isListening { return .red }
        return .green
    }

    // MARK: - Actions

    private func toggleListening() async {
        if speech.isListening {
            speech.stop()
            let text = speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { await sendMessage(text) }
        } else {
            tts.stop()
            let ok = await speech.requestPermissions()
            guard ok else {
                statusText = "Mikrofon/Spracherkennung verweigert"
                return
            }
            speech.start()
            statusText = "höre zu…"
        }
    }

    private func sendMessage(_ text: String) async {
        let userMsg = ChatMessage(role: .user, text: text)
        messages.append(userMsg)
        sending = true
        statusText = "sende…"

        var assistantText = ""
        var assistantMsg = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(assistantMsg)
        let assistantID = assistantMsg.id

        do {
            let stream = await api.sendStream(
                baseURL: settings.backendURL,
                user: settings.authUser,
                pass: settings.authPass,
                chatId: settings.chatId,
                message: text
            )
            for try await ev in stream {
                switch ev {
                case .delta(let chunk):
                    assistantText += chunk
                    if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                        messages[idx].text = assistantText
                    }
                    if settings.speakReplies && settings.speakStreaming, chunk.contains(where: { ".!?\n".contains($0) }) {
                        // optional: streaming TTS pro Satz — Phase 2
                    }
                case .toolUse(let name, _):
                    statusText = "Tool: \(name)"
                case .toolResult:
                    break
                case .done:
                    statusText = "fertig"
                case .error(let err):
                    if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                        messages[idx].text = "⚠ \(err)"
                    }
                }
            }
            if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                messages[idx].isStreaming = false
            }
            if settings.speakReplies && !settings.speakStreaming, !assistantText.isEmpty {
                tts.speak(assistantText, language: settings.ttsVoice)
            }
        } catch {
            if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                messages[idx].text = "⚠ Fehler: \(error.localizedDescription)"
                messages[idx].isStreaming = false
            }
            statusText = "Fehler"
        }
        sending = false
    }
}

private struct MessageBubble: View {
    let msg: ChatMessage

    var body: some View {
        HStack {
            if msg.role == .user { Spacer(minLength: 40) }
            VStack(alignment: msg.role == .user ? .trailing : .leading, spacing: 2) {
                Text(msg.role.rawValue.uppercased())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(msg.text.isEmpty && msg.isStreaming ? "…" : msg.text)
                    .padding(10)
                    .background(bg)
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .textSelection(.enabled)
            }
            if msg.role != .user { Spacer(minLength: 40) }
        }
    }

    private var bg: Color {
        switch msg.role {
        case .user: return .accentColor.opacity(0.25)
        case .assistant: return Color(.secondarySystemBackground)
        case .tool: return Color(.tertiarySystemBackground)
        case .error: return .red.opacity(0.2)
        case .system: return .gray.opacity(0.2)
        }
    }
}

#Preview {
    ContentView().environmentObject(AppSettings())
}
