import SwiftUI

struct ChatView: View {
    @EnvironmentObject var state: AppState
    @State private var input: String = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if state.showingSettings {
                SettingsView()
            } else {
                messageList
                Divider()
                inputBar
            }
        }
        .task {
            if state.isConfigured && state.messages.isEmpty {
                await state.loadHistory()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "brain.head.profile")
            Text("JARVIS").font(.headline)
            if !state.isConfigured {
                Image(systemName: "exclamationmark.circle.fill").foregroundColor(.orange)
            }
            Spacer()
            Button {
                Task { await state.loadHistory() }
            } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help("Verlauf neu laden")
                .disabled(!state.isConfigured)
            Button {
                Task { await state.clear() }
            } label: { Image(systemName: "trash") }
                .buttonStyle(.borderless)
                .help("Verlauf löschen")
                .disabled(!state.isConfigured)
            Button {
                state.showingSettings.toggle()
            } label: { Image(systemName: "gearshape") }
                .buttonStyle(.borderless)
                .help("Einstellungen")
            Button {
                NSApplication.shared.terminate(nil)
            } label: { Image(systemName: "power") }
                .buttonStyle(.borderless)
                .help("Beenden")
        }
        .padding(8)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if state.messages.isEmpty && !state.isSending {
                        Text("Noch keine Nachrichten.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .padding()
                    }
                    ForEach(state.messages) { msg in
                        MessageBubble(msg: msg).id(msg.id)
                    }
                    if state.isSending {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("denkt nach…")
                                .foregroundColor(.secondary)
                                .font(.caption)
                        }
                        .padding(.horizontal, 8)
                        .id("loading")
                    }
                }
                .padding(8)
            }
            .onChange(of: state.messages.count) { _ in
                if let last = state.messages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .onChange(of: state.isSending) { sending in
                if sending { withAnimation { proxy.scrollTo("loading", anchor: .bottom) } }
            }
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Nachricht…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .onSubmit { sendMessage() }
            Button {
                sendMessage()
            } label: {
                Image(systemName: "paperplane.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || state.isSending || !state.isConfigured)
            .keyboardShortcut(.return, modifiers: [.command])
        }
        .padding(8)
    }

    private func sendMessage() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        Task { await state.send(text) }
    }
}

struct MessageBubble: View {
    let msg: ChatMessage

    var body: some View {
        HStack(alignment: .top) {
            if msg.role == "user" { Spacer(minLength: 40) }
            Text(msg.text)
                .padding(8)
                .background(msg.role == "user"
                    ? Color.accentColor.opacity(0.85)
                    : Color.gray.opacity(0.18))
                .foregroundColor(msg.role == "user" ? .white : .primary)
                .cornerRadius(10)
                .textSelection(.enabled)
                .frame(maxWidth: 320, alignment: .leading)
            if msg.role != "user" { Spacer(minLength: 40) }
        }
    }
}
