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
            ZStack {
                Theme.bgDeep.ignoresSafeArea()
                VStack(spacing: 0) {
                    statusBar
                    messagesList
                    inputBar
                }
            }
            .navigationTitle("JARVIS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(Theme.bgDeep, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(Theme.accent)
                    }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task { _ = await speech.requestPermissions() }
        }
        .tint(Theme.accent)
    }

    // MARK: - Subviews

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)
                .shadow(color: statusColor.opacity(0.7), radius: 6)
            Text(statusText)
                .font(.caption.monospaced())
                .foregroundStyle(Theme.textDim)
            Spacer()
            if speech.isListening {
                Text(speech.transcript.isEmpty ? "höre zu…" : speech.transcript)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(Theme.accent)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.bgCard)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.bgHairline), alignment: .bottom)
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
            .scrollContentBackground(.hidden)
            .background(Theme.bgDeep)
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 14) {
            Button {
                Task { @MainActor in await toggleListening() }
            } label: {
                ZStack {
                    Circle()
                        .fill(speech.isListening ? Theme.err.opacity(0.15) : Theme.accentSoft)
                        .frame(width: 68, height: 68)
                    Image(systemName: speech.isListening ? "stop.circle.fill" : "mic.circle.fill")
                        .resizable()
                        .frame(width: 60, height: 60)
                        .foregroundStyle(speech.isListening ? Theme.err : Theme.accent)
                        .shadow(color: (speech.isListening ? Theme.err : Theme.accent).opacity(0.6), radius: 12)
                }
            }
            .disabled(sending)

            VStack(alignment: .leading, spacing: 3) {
                Text(speech.isListening ? "Loslassen / Stop drücken" : "Halte zum Sprechen")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                Text(sending ? "JARVIS denkt…" : (tts.isSpeaking ? "spricht…" : "tippe oder sprich"))
                    .font(.caption)
                    .foregroundStyle(Theme.textDim)
            }
            Spacer()
            if tts.isSpeaking {
                Button { tts.stop() } label: {
                    Image(systemName: "speaker.slash.fill")
                        .foregroundStyle(Theme.warn)
                }
            }
        }
        .padding(14)
        .background(Theme.bgCard)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.bgHairline), alignment: .top)
    }

    private var statusColor: Color {
        if sending { return Theme.warn }
        if tts.isSpeaking { return Theme.accent }
        if speech.isListening { return Theme.err }
        return Theme.ok
    }

    // MARK: - Actions

    @MainActor
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

    @MainActor
    private func sendMessage(_ text: String) async {
        let userMsg = ChatMessage(role: .user, text: text)
        messages.append(userMsg)
        sending = true
        statusText = "sende…"

        var assistantText = ""
        let assistantMsg = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(assistantMsg)
        let assistantID = assistantMsg.id

        do {
            statusText = "verbinde…"
            let stream = await api.sendStream(
                baseURL: settings.backendURL,
                user: settings.authUser,
                pass: settings.authPass,
                chatId: settings.chatId,
                message: text
            )
            statusText = "warte auf Antwort…"
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
                tts.speak(assistantText, settings: settings)
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
            VStack(alignment: msg.role == .user ? .trailing : .leading, spacing: 3) {
                Text(msg.role.rawValue.uppercased())
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.textDim)
                    .tracking(0.8)
                Text(msg.text.isEmpty && msg.isStreaming ? "…" : msg.text)
                    .foregroundStyle(textColor)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(bg)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .strokeBorder(borderColor, lineWidth: 0.8)
                    )
                    .textSelection(.enabled)
            }
            if msg.role != .user { Spacer(minLength: 40) }
        }
    }

    private var bg: Color {
        switch msg.role {
        case .user:      return Theme.bubbleUser
        case .assistant: return Theme.bubbleAssist
        case .tool:      return Theme.bgCard
        case .error:     return Theme.err.opacity(0.18)
        case .system:    return Theme.bgCard
        }
    }

    private var borderColor: Color {
        switch msg.role {
        case .user:      return Theme.accent.opacity(0.5)
        case .assistant: return Theme.bgHairline
        case .tool:      return Theme.bgHairline.opacity(0.7)
        case .error:     return Theme.err.opacity(0.6)
        case .system:    return Theme.bgHairline
        }
    }

    private var textColor: Color {
        switch msg.role {
        case .error: return Theme.err
        case .tool:  return Theme.textDim
        default:     return Theme.text
        }
    }
}

#Preview {
    ContentView().environmentObject(AppSettings())
}
