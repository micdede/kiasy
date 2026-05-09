import SwiftUI
import PhotosUI
import PDFKit
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject var settings: AppSettings
    @StateObject private var speech = SpeechService()
    @StateObject private var tts = TTSService()
    @State private var messages: [ChatMessage] = []
    @State private var pending: ChatMessage? = nil
    @State private var sending = false
    @State private var showSettings = false
    @State private var showConversation = false
    @State private var statusText = "bereit"
    @State private var inputText = ""
    @FocusState private var inputFocused: Bool
    // Attachment-Pipeline
    @State private var pendingAttachments: [ChatMessage.LocalAttachment] = []
    @State private var photoPickerItem: PhotosPickerItem?
    @State private var showPhotosPicker = false
    @State private var showFileImporter = false

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
        .fullScreenCover(isPresented: $showConversation) {
            ConversationView(speech: speech, tts: tts, sending: $sending)
                .environmentObject(settings)
        }
        .task {
            _ = await speech.requestPermissions()
            await loadHistoryIfEmpty()
        }
        // Auto-Send beim Mic-Stop — egal ob User-Stop, isFinal vom Recognizer
        // oder Silence-Timeout im Konversations-Modus.
        .onChange(of: speech.isListening) { wasListening, listening in
            if wasListening && !listening {
                let text = speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    Task { @MainActor in await sendMessage(text) }
                }
            }
        }
        // Trigger via AppIntent (Action-Button, Siri, Back-Tap, Widget, Watch …)
        .onReceive(NotificationCenter.default.publisher(for: .startListeningTrigger)) { _ in
            triggerListeningExplicit()
        }
        // Konversations-Modus: nach TTS-Ende Mic wieder auf (TTS-Pfad)
        .onChange(of: tts.isSpeaking) { _, speaking in
            if !speaking { maybeAutoContinue() }
        }
        // Konversations-Modus: wenn TTS aus ist, am Ende des Sendens triggern
        // (sonst gibt's kein TTS-Event auf das wir warten könnten)
        .onChange(of: sending) { _, isSending in
            if !isSending && !settings.speakReplies { maybeAutoContinue() }
        }
    }

    /// Startet das Mic erneut wenn Konversations-Modus aktiv ist und nichts
    /// anderes gerade läuft. 250 ms Delay damit die Audio-Session frei wird.
    @MainActor
    private func maybeAutoContinue() {
        guard settings.conversationMode else { return }
        guard !speech.isListening, !sending, !tts.isSpeaking else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard settings.conversationMode, !speech.isListening, !sending, !tts.isSpeaking else { return }
            speech.start(silenceTimeout: 6)
            statusText = "höre zu…"
        }
    }

    /// Silence-Timeout für Aufnahmen — nur im Konversations-Modus aktiv,
    /// damit das Mic nicht ewig offen bleibt wenn der User nichts sagt.
    private var silenceTimeoutForStart: TimeInterval? {
        settings.conversationMode ? 6 : nil
    }

    /// Expliziter User-Trigger (Action-Button, Doppel-Tap auf Header, Siri, …).
    /// TTS wird immer abgewürgt — wer einen Knopf drückt, will sofort reden.
    @MainActor
    private func triggerListeningExplicit() {
        if speech.isListening { return }
        tts.stop()
        Task { @MainActor in await toggleListening() }
    }

    /// Lädt den Chat-Verlauf vom Server beim ersten View-Mount.
    /// Skip wenn schon Messages drin sind (User hat in der Zwischenzeit getippt
    /// oder die View wurde nur re-mounted ohne dass die App neu gestartet wurde).
    private func loadHistoryIfEmpty() async {
        guard messages.isEmpty else { return }
        guard !settings.backendURL.isEmpty else { return }
        do {
            let loaded = try await api.loadHistory(
                baseURL: settings.backendURL,
                user: settings.authUser,
                pass: settings.authPass,
                chatId: settings.chatId,
                limit: 50
            )
            // Race-Schutz: zwischen await und hier könnte User schon getippt haben
            guard messages.isEmpty else { return }
            messages = loaded
        } catch {
            print("[history] load failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Subviews

    private var customHeader: some View {
        HStack(spacing: 10) {
            // Status-LED
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .shadow(color: statusColor.opacity(0.85), radius: 5)

            // Wordmark — Doppel-Tap startet Aufnahme (Quick-Trigger)
            Text("J A R V I S")
                .font(.system(size: 18, weight: .heavy, design: .monospaced))
                .tracking(1.5)
                .foregroundStyle(
                    LinearGradient(colors: [Theme.accent, Theme.text],
                                   startPoint: .leading, endPoint: .trailing)
                )
                .shadow(color: Theme.accent.opacity(0.6), radius: 4)
                .contentShape(Rectangle())  // gesamten Wordmark-Bereich tappable
                .onTapGesture(count: 2) { triggerListeningExplicit() }

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
        VStack(spacing: 0) {
            // Pending-Attachments Vorschau (nur sichtbar wenn welche da)
            if !pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingAttachments, id: \.filename) { att in
                            attachmentPreview(att)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .background(Theme.bgCard)
                .transition(.opacity)
            }

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

            // Anhängen-Button (Photos + Files Menu)
            // PhotosPicker im Menu funktioniert nicht (Apple-Bug, Menu schluckt
            // Tap-Geste). Workaround: Menu setzt nur Flag, .photosPicker-Modifier
            // außen am VStack zeigt den Picker modal.
            Menu {
                Button {
                    showPhotosPicker = true
                } label: { Label("Foto auswählen", systemImage: "photo") }
                Button {
                    showFileImporter = true
                } label: { Label("Datei (PDF) auswählen", systemImage: "doc") }
            } label: {
                Image(systemName: "paperclip")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 34, height: 34)
                    .background(Theme.accentSoft)
                    .clipShape(Circle())
            }
            .disabled(sending)

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

            // Send wenn Text → Send, sonst Mic + Voice-Mode-Button
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
                // Voice-Mode-Button (Sprechblase)
                Button { showConversation = true } label: {
                    iconCircle(name: "waveform.circle.fill", tint: Theme.accent, size: 38)
                }
                .disabled(sending || speech.isListening)
                .transition(.scale.combined(with: .opacity))
            }
            }  // close inner HStack
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Theme.bgCard)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.accent.opacity(0.2)), alignment: .top)
        .animation(.easeInOut(duration: 0.18), value: inputText.isEmpty)
        .animation(.easeInOut(duration: 0.18), value: tts.isSpeaking)
        .animation(.easeInOut(duration: 0.18), value: pendingAttachments.count)
        // Photos-Picker als Modifier (funktioniert auch wenn Menu offen war)
        .photosPicker(
            isPresented: $showPhotosPicker,
            selection: $photoPickerItem,
            matching: .images
        )
        // Foto-Auswahl → Daten extrahieren + zu pendingAttachments
        .onChange(of: photoPickerItem) { _, item in
            guard let item else { return }
            Task { await loadPhotoPickerItem(item) }
        }
        // Datei-Importer (PDF)
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.pdf],
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
        }
    }

    /// Vorschau eines pending-Attachments im Input-Bar (kleines Thumbnail mit X-Button)
    @ViewBuilder
    private func attachmentPreview(_ att: ChatMessage.LocalAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                switch att.kind {
                case .image:
                    if let img = UIImage(data: att.data) {
                        Image(uiImage: img)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 60, height: 60)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                case .pdf:
                    VStack(spacing: 4) {
                        Image(systemName: "doc.fill")
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.accent)
                        Text(att.filename)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .frame(width: 60, height: 60)
                    .background(Theme.bgElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.bgHairline, lineWidth: 0.8))

            // Remove-Button
            Button {
                pendingAttachments.removeAll(where: { $0.filename == att.filename })
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(Theme.text)
                    .background(Circle().fill(Color.black.opacity(0.6)))
            }
            .offset(x: 6, y: -6)
        }
    }

    @MainActor
    private func loadPhotoPickerItem(_ item: PhotosPickerItem) async {
        defer { photoPickerItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        // JPEG re-encode falls riesig (>2MB) — sonst werden Backend-Requests sehr fett
        let finalData: Data = {
            if data.count <= 2_000_000 { return data }
            if let img = UIImage(data: data), let jpeg = img.jpegData(compressionQuality: 0.7) {
                return jpeg
            }
            return data
        }()
        let name = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
        pendingAttachments.append(.init(kind: .image, filename: name, data: finalData))
    }

    @MainActor
    private func handleFileImport(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first else { return }
        // security-scoped Resource — auf iOS sind picker-Files in einer Sandbox
        let didStart = url.startAccessingSecurityScopedResource()
        defer { if didStart { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let name = url.lastPathComponent
        pendingAttachments.append(.init(kind: .pdf, filename: name, data: data))
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
            // Send wird im onChange(of: speech.isListening)-Observer ausgelöst —
            // greift dann sowohl bei User-Stop hier als auch bei Silence-Timeout
            speech.stop()
        } else {
            tts.stop()
            let ok = await speech.requestPermissions()
            guard ok else {
                statusText = "Mikrofon/Spracherkennung verweigert"
                return
            }
            speech.start(silenceTimeout: silenceTimeoutForStart)
            statusText = "höre zu…"
        }
    }

    @MainActor
    private func sendMessage(_ text: String) async {
        // Pending-Attachments übernehmen + sofort leeren (lokal in User-Bubble festhalten)
        let attachmentsForBubble = pendingAttachments
        pendingAttachments.removeAll()

        // Server-Format: PDFs als Text extrahieren und an message anhängen,
        // Bilder als base64-image-Attachments für Multi-Modal
        var serverMessage = text
        var serverAttachments: [JarvisAPI.Attachment] = []
        for att in attachmentsForBubble {
            switch att.kind {
            case .image:
                let mime = att.filename.lowercased().hasSuffix(".png") ? "image/png" : "image/jpeg"
                serverAttachments.append(.init(
                    type: "image",
                    mime: mime,
                    base64: att.data.base64EncodedString()
                ))
            case .pdf:
                if let extracted = extractPDFText(att.data), !extracted.isEmpty {
                    let header = "\n\n[Anhang: PDF \"\(att.filename)\"]\n"
                    serverMessage += header + extracted
                } else {
                    serverMessage += "\n\n[Anhang: PDF \"\(att.filename)\" — kein Text extrahierbar]"
                }
            }
        }

        let userMsg = ChatMessage(role: .user, text: text, localAttachments: attachmentsForBubble)
        messages.append(userMsg)
        sending = true
        statusText = "sende…"

        var assistantText = ""
        let assistantMsg = ChatMessage(role: .assistant, text: "", isStreaming: true)
        messages.append(assistantMsg)
        let assistantID = assistantMsg.id

        // Streaming-TTS: Buffer für noch-nicht-gesprochene Token. Bei Satz-Ende
        // wird das Stück abgeschnitten und in die TTS-Queue gehängt.
        let useStreamingTTS = settings.speakReplies && settings.speakStreaming
        var ttsBuffer = ""
        let minChunkLen = 30  // sehr kurze Sätze sammeln statt einzeln zu sprechen

        do {
            statusText = "verbinde…"
            let stream = await api.sendStream(
                baseURL: settings.backendURL,
                user: settings.authUser,
                pass: settings.authPass,
                chatId: settings.chatId,
                message: serverMessage,
                attachments: serverAttachments
            )
            statusText = "warte auf Antwort…"
            for try await ev in stream {
                switch ev {
                case .delta(let chunk):
                    assistantText += chunk
                    if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                        messages[idx].text = assistantText
                    }
                    if useStreamingTTS {
                        ttsBuffer += chunk
                        // Mehrere Sätze in einem großen Chunk: solange splitten
                        // bis nichts mehr geht. Backend streamt manchmal in
                        // grossen Brocken (minimax-cloud) statt token-by-token.
                        while ttsBuffer.count >= minChunkLen,
                              let split = sentenceSplit(ttsBuffer) {
                            tts.enqueueSpeak(split.spoken, settings: settings)
                            ttsBuffer = split.remainder
                        }
                    }
                case .toolUse(let name, _):
                    statusText = "Tool: \(name)"
                case .toolResult(let any):
                    // Wenn das Tool eine /api/images/... URL liefert → Inline-Image.
                    // Wenn ein Tool eine download_url (z.B. /api/files/...) liefert →
                    // als Datei-Card mit ShareLink rendern.
                    if let dict = any as? [String: Any] {
                        if let path = dict["url"] as? String, path.hasPrefix("/api/images/") {
                            let full = "\(settings.backendURL)\(path)"
                            if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                                messages[idx].imageURL = full
                            }
                        }
                        if let path = dict["download_url"] as? String {
                            let full = "\(settings.backendURL)\(path)"
                            let name = (dict["filename"] as? String)
                                ?? URL(string: full)?.lastPathComponent
                                ?? "Datei"
                            if let idx = messages.firstIndex(where: { $0.id == assistantID }) {
                                messages[idx].downloadURL = full
                                messages[idx].downloadFilename = name
                            }
                        }
                    }
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
            if useStreamingTTS {
                // Rest aus dem Buffer noch sprechen (letzter Satz hatte vielleicht
                // kein Satzzeichen am Ende)
                let remaining = ttsBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
                if !remaining.isEmpty {
                    tts.enqueueSpeak(remaining, settings: settings)
                }
            } else if settings.speakReplies, !assistantText.isEmpty {
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

    /// Findet das LETZTE Satz-Ende-Zeichen (.!?) bzw. Doppel-Newline im Buffer.
    /// Splittet dort und liefert (gesprochener Teil, Rest) — oder nil wenn kein
    /// Satz-Ende drin ist (dann Buffer weiterwachsen lassen).
    /// Reagiert nicht auf Punkte mitten in Wörtern (Abkürzungen wie z.B.) — danach
    /// muss ein Whitespace folgen damit's als Satz-Ende zählt.
    private func sentenceSplit(_ buffer: String) -> (spoken: String, remainder: String)? {
        let chars = Array(buffer)
        var lastSentenceEnd: Int? = nil
        for i in stride(from: chars.count - 1, through: 1, by: -1) {
            let c = chars[i]
            // Doppelte Newline = Absatz-Ende
            if c == "\n", i > 0, chars[i - 1] == "\n" {
                lastSentenceEnd = i + 1; break
            }
            // .!? gefolgt von Whitespace oder Newline
            if (c == " " || c == "\n"), i > 0 {
                let prev = chars[i - 1]
                if ".!?".contains(prev) {
                    lastSentenceEnd = i + 1; break
                }
            }
        }
        guard let split = lastSentenceEnd else { return nil }
        let spoken = String(chars[0..<split]).trimmingCharacters(in: .whitespacesAndNewlines)
        let remainder = String(chars[split..<chars.count])
        guard !spoken.isEmpty else { return nil }
        return (spoken, remainder)
    }

    /// Extrahiert reinen Text aus einem PDF (PDFKit). Liefert nil wenn das PDF
    /// nicht parsebar ist oder kein Text drin ist (z.B. reines Scan-Image-PDF
    /// ohne OCR — könnten wir später server-seitig mit Vision lösen).
    private func extractPDFText(_ data: Data) -> String? {
        guard let doc = PDFDocument(data: data) else { return nil }
        var collected = ""
        for i in 0..<doc.pageCount {
            if let pageText = doc.page(at: i)?.string {
                collected += pageText + "\n\n"
            }
        }
        let trimmed = collected.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct MessageBubble: View {
    @EnvironmentObject var settings: AppSettings
    let msg: ChatMessage

    @State private var pdfPreview: ChatMessage.LocalAttachment?

    var body: some View {
        HStack {
            if msg.role == .user { Spacer(minLength: 40) }
            VStack(alignment: msg.role == .user ? .trailing : .leading, spacing: 6) {
                Text(msg.role.rawValue.uppercased())
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.textDim)
                    .tracking(0.8)
                // Lokal angehängte Files (User-Uploads) — über dem Text
                if !msg.localAttachments.isEmpty {
                    ForEach(msg.localAttachments, id: \.filename) { att in
                        localAttachmentBubble(att)
                    }
                }
                if !msg.text.isEmpty || msg.isStreaming {
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
                // Server-erzeugte Datei (Tool-Result mit download_url) als Card
                if let urlString = msg.downloadURL,
                   let url = authedURL(urlString) {
                    serverFileCard(url: url, filename: msg.downloadFilename ?? "Datei")
                }
                if let urlString = msg.imageURL, let url = authedURL(urlString) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .empty:
                            ZStack {
                                RoundedRectangle(cornerRadius: 14).fill(Theme.bgElevated)
                                ProgressView().tint(Theme.accent)
                            }.frame(width: 240, height: 240)
                        case .success(let img):
                            img.resizable().scaledToFit()
                                .frame(maxWidth: 320)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 14)
                                    .strokeBorder(Theme.accent.opacity(0.4), lineWidth: 0.8))
                                .contextMenu {
                                    Button {
                                        Task { await saveImageToPhotos(from: url) }
                                    } label: { Label("In Fotos sichern", systemImage: "square.and.arrow.down") }
                                    ShareLink(item: url) {
                                        Label("Teilen", systemImage: "square.and.arrow.up")
                                    }
                                    Button {
                                        UIPasteboard.general.url = url
                                    } label: { Label("URL kopieren", systemImage: "doc.on.doc") }
                                }
                        case .failure:
                            Text("⚠ Bild nicht ladbar")
                                .font(.caption).foregroundStyle(Theme.err)
                                .padding(10).background(Theme.err.opacity(0.15))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        @unknown default:
                            EmptyView()
                        }
                    }
                }
            }
            if msg.role != .user { Spacer(minLength: 40) }
        }
        .sheet(item: $pdfPreview) { att in
            PDFPreview(data: att.data, title: att.filename)
        }
    }

    /// Server-erzeugte Datei (z.B. CSV-Export) — Card mit ShareLink.
    /// Tap auf Share öffnet das System-Sheet (In Files speichern, Mail, ...).
    @ViewBuilder
    private func serverFileCard(url: URL, filename: String) -> some View {
        ShareLink(item: url, preview: SharePreview(filename)) {
            HStack(spacing: 10) {
                Image(systemName: iconForFilename(filename))
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(filename)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("Tippen zum Speichern/Teilen")
                        .font(.caption2)
                        .foregroundStyle(Theme.textDim)
                }
                Spacer(minLength: 4)
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.accent)
            }
            .padding(10)
            .background(Theme.bgElevated)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Theme.accent.opacity(0.4), lineWidth: 0.8))
            .frame(maxWidth: 280)
        }
    }

    private func iconForFilename(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "csv":            return "tablecells"
        case "json", "xml":    return "curlybraces"
        case "pdf":            return "doc.richtext"
        case "txt", "md":      return "doc.text"
        case "zip":            return "doc.zipper"
        case "png", "jpg", "jpeg", "svg": return "photo"
        default:               return "doc"
        }
    }

    /// Lokal angehängtes File (User-Upload) — Bild als Inline-Image, PDF als
    /// File-Card mit Tap → Vollbild-PDF-Viewer.
    @ViewBuilder
    private func localAttachmentBubble(_ att: ChatMessage.LocalAttachment) -> some View {
        switch att.kind {
        case .image:
            if let img = UIImage(data: att.data) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(Theme.accent.opacity(0.5), lineWidth: 0.8))
            }
        case .pdf:
            Button { pdfPreview = att } label: {
                HStack(spacing: 10) {
                    Image(systemName: "doc.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(att.filename)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text("\(att.data.count / 1024) KB · zum Öffnen tippen")
                            .font(.caption2)
                            .foregroundStyle(Theme.textDim)
                    }
                    Spacer(minLength: 4)
                }
                .padding(10)
                .background(Theme.bgElevated)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Theme.bgHairline, lineWidth: 0.8))
                .frame(maxWidth: 260)
            }
            .buttonStyle(.plain)
        }
    }

    /// Lädt das Bild von der URL (mit Basic-Auth via authedURL) und speichert
    /// es in der Foto-Mediathek. Apple zeigt automatisch einen Permission-Prompt
    /// beim ersten Mal (NSPhotoLibraryAddUsageDescription in Info.plist).
    private func saveImageToPhotos(from url: URL) async {
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let image = UIImage(data: data) else { return }
            UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
        } catch {
            print("[image-save] failed: \(error.localizedDescription)")
        }
    }

    /// Embeddet Basic-Auth in die URL (URLSession akzeptiert https://user:pass@host).
    private func authedURL(_ s: String) -> URL? {
        guard !settings.authUser.isEmpty,
              var comps = URLComponents(string: s) else { return URL(string: s) }
        comps.user = settings.authUser
        comps.password = settings.authPass
        return comps.url
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

/// Vollbild-PDF-Viewer via PDFKit. Wird als Sheet beim Tap auf eine PDF-Bubble
/// geöffnet. Theme-konsistent (dunkel) mit Schließen-Button.
private struct PDFPreview: View {
    let data: Data
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PDFKitView(data: data)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Fertig") { dismiss() }.foregroundStyle(Theme.accent)
                    }
                }
        }
        .preferredColorScheme(.dark)
    }
}

private struct PDFKitView: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.document = PDFDocument(data: data)
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.backgroundColor = .black
        return v
    }
    func updateUIView(_ uiView: PDFView, context: Context) {
        if uiView.document == nil { uiView.document = PDFDocument(data: data) }
    }
}

#Preview {
    ContentView().environmentObject(AppSettings())
}
