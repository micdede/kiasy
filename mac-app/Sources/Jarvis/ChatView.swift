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
                state.ttsEnabled.toggle()
                if !state.ttsEnabled { state.stopTTS() }
            } label: {
                Image(systemName: state.ttsEnabled ? "speaker.wave.2.fill" : "speaker.slash")
                    .foregroundColor(state.ttsEnabled ? .accentColor : .secondary)
            }
            .buttonStyle(.borderless)
            .help(state.ttsEnabled ? "TTS aus" : "TTS an")

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
        VStack(spacing: 6) {
            if let err = state.lastError {
                Text(err)
                    .font(.caption2)
                    .foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .bottom, spacing: 6) {
                Button {
                    Task { await toggleRecording() }
                } label: {
                    Image(systemName: state.recorder.isRecording ? "stop.circle.fill" : "mic.fill")
                        .foregroundColor(state.recorder.isRecording ? .red : .accentColor)
                        .font(.system(size: 18))
                }
                .buttonStyle(.borderless)
                .help(state.recorder.isRecording ? "Aufnahme stoppen & senden" : "Sprachnachricht aufnehmen")
                .disabled(state.isSending || !state.isConfigured)

                TextField("Nachricht…", text: $input, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .onSubmit { sendMessage() }
                    .disabled(state.recorder.isRecording)

                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty
                          || state.isSending
                          || !state.isConfigured
                          || state.recorder.isRecording)
                .keyboardShortcut(.return, modifiers: [.command])
            }
        }
        .padding(8)
    }

    private func sendMessage() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        Task { await state.send(text) }
    }

    private func toggleRecording() async {
        if state.recorder.isRecording {
            await state.stopRecordingAndSend()
        } else {
            await state.startRecording()
        }
    }
}

struct MessageBubble: View {
    let msg: ChatMessage
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(alignment: .top) {
            if msg.role == "user" { Spacer(minLength: 40) }
            VStack(alignment: msg.role == "user" ? .trailing : .leading, spacing: 4) {
                if !msg.text.isEmpty {
                    Text(msg.text)
                        .padding(8)
                        .background(msg.role == "user"
                            ? Color.accentColor.opacity(0.85)
                            : Color.gray.opacity(0.18))
                        .foregroundColor(msg.role == "user" ? .white : .primary)
                        .cornerRadius(10)
                        .textSelection(.enabled)
                        .frame(maxWidth: 320, alignment: msg.role == "user" ? .trailing : .leading)
                }
                ForEach(msg.images) { img in
                    RemoteImage(image: img)
                        .frame(maxWidth: 320)
                }
                if msg.role == "assistant" && !msg.text.isEmpty {
                    Button {
                        Task { await state.playTTS(msg.text) }
                    } label: {
                        Image(systemName: "speaker.wave.2")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Vorlesen")
                }
            }
            if msg.role != "user" { Spacer(minLength: 40) }
        }
    }
}

struct RemoteImage: View {
    let image: ChatImage
    @EnvironmentObject var state: AppState
    @State private var nsImage: NSImage?
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let img = nsImage {
                Image(nsImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .cornerRadius(8)
                    .onTapGesture { openExternally(img) }
            } else if loading {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Bild lädt…").font(.caption).foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let errorText = errorText {
                Text("⚠️ \(errorText)").font(.caption).foregroundColor(.red)
            }
            if !image.caption.isEmpty {
                Text(image.caption)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .lineLimit(3)
            }
        }
        .task {
            do {
                let data = try await state.fetchImage(image)
                nsImage = NSImage(data: data)
                loading = false
            } catch {
                errorText = error.localizedDescription
                loading = false
            }
        }
    }

    private func openExternally(_ img: NSImage) {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("jarvis-\(UUID().uuidString).png")
        if let tiff = img.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try? png.write(to: tmp)
            NSWorkspace.shared.open(tmp)
        }
    }
}
