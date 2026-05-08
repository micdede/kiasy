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
    @State private var inputText = ""
    @FocusState private var inputFocused: Bool

    private let api = JarvisAPI()

    var body: some View {
        ZStack {
            Theme.bgDeep.ignoresSafeArea()
            VStack(spacing: 0) {
                customHeader
                messagesList
                inputBar
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showSettings) { SettingsView(messages: $messages) }
        .task { _ = await speech.requestPermissions() }
    }

    // MARK: - Subviews

    private var customHeader: some View {
        HStack(spacing: 10) {
            // Status-LED
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .shadow(color: statusColor.opacity(0.85), radius: 5)

            // Wordmark
            Text("J A R V I S")
                .font(.system(size: 18, weight: .heavy, design: .monospaced))
                .tracking(1.5)
                .foregroundStyle(
                    LinearGradient(colors: [Theme.accent, Theme.text],
                                   startPoint: .leading, endPoint: .trailing)
                )
                .shadow(color: Theme.accent.opacity(0.6), radius: 4)

            // Status-Text klein dahinter
            Text(speech.isListening
                 ? (speech.transcript.isEmpty ? "höre zu…" : speech.transcript)
                 : statusText)
                .font(.caption2.monospaced())
                .foregroundStyle(speech.isListening ? Theme.accent : Theme.textDim)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            Button { showSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .padding(8)
                    .background(Theme.accentSoft)
                    .clipShape(Circle())
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Theme.bgCard)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.accent.opacity(0.25)), alignment: .bottom)
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
        HStack(spacing: 8) {
            // Stop-TTS-Pill (nur sichtbar während TTS läuft)
            if tts.isSpeaking {
                Button { tts.stop() } label: {
                    Image(systemName: "speaker.slash.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.warn)
                        .frame(width: 32, height: 32)
                        .background(Theme.warn.opacity(0.15))
                        .clipShape(Circle())
                }
                .transition(.scale.combined(with: .opacity))
            }

            // Textfeld
            HStack(spacing: 6) {
                TextField("", text: $inputText, axis: .vertical)
                    .placeholder(when: inputText.isEmpty) {
                        Text(speech.isListening
                             ? (speech.transcript.isEmpty ? "höre zu…" : speech.transcript)
                             : "Nachricht…")
                            .foregroundStyle(speech.isListening ? Theme.accent : Theme.textDim)
                    }
                    .foregroundStyle(Theme.text)
                    .tint(Theme.accent)
                    .focused($inputFocused)
                    .lineLimit(1...4)
                    .submitLabel(.send)
                    .onSubmit { Task { await sendTyped() } }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .background(Theme.bgElevated)
            .clipShape(Capsule())
            .overlay(
                Capsule().strokeBorder(
                    speech.isListening ? Theme.accent.opacity(0.6) : Theme.bgHairline,
                    lineWidth: 0.8
                )
            )

            // Send wenn Text → Send, sonst Mic
            if !inputText.trimmingCharacters(in: .whitespaces).isEmpty {
                Button { Task { await sendTyped() } } label: {
                    iconCircle(name: "arrow.up", tint: Theme.accent, size: 38)
                }
                .disabled(sending)
                .transition(.scale.combined(with: .opacity))
            } else {
                Button {
                    Task { @MainActor in await toggleListening() }
                } label: {
                    iconCircle(
                        name: speech.isListening ? "stop.fill" : "mic.fill",
                        tint: speech.isListening ? Theme.err : Theme.accent,
                        size: 38
                    )
                    .scaleEffect(speech.isListening ? 1.08 : 1.0)
                }
                .disabled(sending)
                .animation(.easeInOut(duration: 0.15), value: speech.isListening)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bgCard)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.accent.opacity(0.2)), alignment: .top)
        .animation(.easeInOut(duration: 0.18), value: inputText.isEmpty)
        .animation(.easeInOut(duration: 0.18), value: tts.isSpeaking)
    }

    @ViewBuilder
    private func iconCircle(name: String, tint: Color, size: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(tint.opacity(0.18))
                .frame(width: size, height: size)
            Image(systemName: name)
                .font(.system(size: size * 0.42, weight: .bold))
                .foregroundStyle(tint)
                .shadow(color: tint.opacity(0.7), radius: 6)
        }
    }

    @MainActor
    private func sendTyped() async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""
        inputFocused = false
        await sendMessage(text)
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
