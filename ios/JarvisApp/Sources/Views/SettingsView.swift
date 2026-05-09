import SwiftUI
import AVFoundation

struct PiperVoice: Identifiable, Hashable {
    let voice: String   // z.B. "de_DE-thorsten-high"
    let name: String
    let lang: String
    let flag: String
    let quality: String
    let gender: String
    var id: String { voice }
}

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @Binding var messages: [ChatMessage]
    @ObservedObject var wake: WakeWordService
    @State private var probeResult: String = ""
    @State private var probing = false
    @State private var piperVoices: [PiperVoice] = []
    @State private var piperLoading = false
    @State private var piperError: String?
    @State private var edgeVoices: [PiperVoice] = []
    @State private var edgeLoading = false
    @State private var edgeError: String?
    @State private var clearStatus: String?
    @State private var showClearConfirm = false

    private var availableVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("de") }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    TextField("Basis-URL (https://…)", text: $settings.backendURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("User", text: $settings.authUser)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Passwort", text: $settings.authPass)
                    TextField("Chat-ID", text: $settings.chatId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button(probing ? "Teste…" : "Verbindung testen") { Task { await probe() } }
                        .disabled(probing)
                    if !probeResult.isEmpty {
                        Text(probeResult).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
                Section("Sprachausgabe") {
                    Toggle("Antworten vorlesen", isOn: $settings.speakReplies)
                    Toggle("Streaming-Vorlesen (Phase 2)", isOn: $settings.speakStreaming)
                        .disabled(true)
                    Picker("Backend", selection: $settings.ttsBackend) {
                        Text("iOS (on-device)").tag("ios")
                        Text("Piper (Server, lokal)").tag("piper")
                        Text("Edge (Server, MS Cloud)").tag("edge")
                    }
                    if settings.ttsBackend == "ios" {
                        Picker("iOS-Stimme", selection: $settings.ttsVoiceID) {
                            Text("Auto (beste de-DE)").tag("")
                            ForEach(availableVoices, id: \.identifier) { v in
                                Text("\(v.name) — \(qualityLabel(v.quality))").tag(v.identifier)
                            }
                        }
                    } else if settings.ttsBackend == "piper" {
                        Picker("Piper-Stimme", selection: $settings.piperVoice) {
                            Text("Server-Default").tag("")
                            ForEach(piperVoices) { pv in
                                Text("\(pv.flag) \(pv.name) — \(pv.quality)").tag(pv.voice)
                            }
                        }
                        if piperLoading { Text("lade Stimmen…").font(.caption).foregroundStyle(.secondary) }
                        if let err = piperError { Text(err).font(.caption).foregroundStyle(.red) }
                        Button("Stimmen laden") { Task { await loadVoices(engine: "piper") } }
                            .disabled(piperLoading)
                    } else {  // "edge"
                        Picker("Edge-Stimme", selection: $settings.edgeVoice) {
                            Text("Server-Default").tag("")
                            ForEach(edgeVoices) { ev in
                                Text("\(ev.flag) \(ev.name)").tag(ev.voice)
                            }
                        }
                        if edgeLoading { Text("lade Stimmen…").font(.caption).foregroundStyle(.secondary) }
                        if let err = edgeError { Text(err).font(.caption).foregroundStyle(.red) }
                        Button("Stimmen laden") { Task { await loadVoices(engine: "edge") } }
                            .disabled(edgeLoading)
                    }
                }
                .task {
                    if settings.ttsBackend == "piper" && piperVoices.isEmpty { await loadVoices(engine: "piper") }
                    if settings.ttsBackend == "edge"  && edgeVoices.isEmpty  { await loadVoices(engine: "edge") }
                }
                Section {
                    SecureField("Picovoice AccessKey", text: $settings.picovoiceAccessKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("Wake-Word \"Jarvis\" aktiv", isOn: $settings.wakeWordEnabled)
                        .disabled(settings.picovoiceAccessKey.isEmpty)
                    Toggle("Barge-In (während TTS unterbrechen)", isOn: $settings.bargeInEnabled)
                        .disabled(!settings.wakeWordEnabled)
                    HStack(spacing: 8) {
                        Circle()
                            .fill(wakeStatusColor)
                            .frame(width: 8, height: 8)
                        Text(wakeStatusText)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                    if let detected = wake.lastDetectedAt {
                        Text("Letztes \"Jarvis\" erkannt: \(detected, style: .relative)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Wake-Word")
                } footer: {
                    Text("Picovoice Console (kostenlos, 3 Geräte): https://console.picovoice.ai\nNach Registrierung den AccessKey aus dem Dashboard hier einfügen. Wake-Word braucht ständigen Mic-Zugriff (~5% CPU, Background-Audio entitlement ist gesetzt).")
                        .font(.caption2)
                }
                Section("Aktionen") {
                    Button(role: .destructive) {
                        showClearConfirm = true
                    } label: {
                        Label("Chat-Verlauf leeren", systemImage: "trash")
                    }
                    if let s = clearStatus {
                        Text(s).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Über") {
                    LabeledContent("Bundle", value: Bundle.main.bundleIdentifier ?? "?")
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgDeep)
            .navigationTitle("Einstellungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(Theme.bgDeep, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                        .foregroundStyle(Theme.accent)
                }
            }
            .confirmationDialog("Chat-Verlauf wirklich leeren?",
                                isPresented: $showClearConfirm,
                                titleVisibility: .visible) {
                Button("Lokal nur", role: .destructive) { clearLocal() }
                Button("Lokal + Server", role: .destructive) { Task { await clearAll() } }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("‚Lokal' leert nur die Bubbles in der App. ‚Lokal + Server' löscht zusätzlich den Verlauf in der JARVIS-Datenbank für diese Chat-ID.")
            }
        }
        .tint(Theme.accent)
    }

    private var wakeStatusColor: Color {
        switch wake.status {
        case .idle:      return Color.gray
        case .ready:     return Color.yellow
        case .listening: return Color.green
        case .error:     return Color.red
        }
    }

    private var wakeStatusText: String {
        switch wake.status {
        case .idle:      return settings.wakeWordEnabled
                                ? (settings.picovoiceAccessKey.isEmpty ? "AccessKey fehlt" : "aus")
                                : "deaktiviert"
        case .ready:     return "bereit (nicht aktiv)"
        case .listening: return "lauscht auf \"Jarvis\""
        case .error(let msg): return "Fehler: \(msg)"
        }
    }

    private func clearLocal() {
        messages.removeAll()
        clearStatus = "App-Verlauf geleert"
    }

    private func clearAll() async {
        clearLocal()
        guard let url = URL(string: "\(settings.backendURL)/api/chat/history?chatId=\(settings.chatId)") else {
            clearStatus = "URL ungültig"; return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        if !settings.authUser.isEmpty {
            let token = "\(settings.authUser):\(settings.authPass)".data(using: .utf8)!.base64EncodedString()
            req.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode == 200,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let n = obj["deleted"] as? Int ?? 0
                clearStatus = "App geleert + \(n) Server-Einträge gelöscht"
            } else {
                clearStatus = "App geleert (Server-Reset fehlgeschlagen)"
            }
        } catch {
            clearStatus = "App geleert (Server-Fehler: \(error.localizedDescription))"
        }
    }

    private func loadVoices(engine: String) async {
        if engine == "piper" { piperLoading = true; piperError = nil } else { edgeLoading = true; edgeError = nil }
        defer { if engine == "piper" { piperLoading = false } else { edgeLoading = false } }
        guard let url = URL(string: "\(settings.backendURL)/api/voice/voices?engine=\(engine)") else {
            if engine == "piper" { piperError = "URL ungültig" } else { edgeError = "URL ungültig" }
            return
        }
        var req = URLRequest(url: url)
        if !settings.authUser.isEmpty {
            let token = "\(settings.authUser):\(settings.authPass)".data(using: .utf8)!.base64EncodedString()
            req.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                if engine == "piper" { piperError = "HTTP-Fehler" } else { edgeError = "HTTP-Fehler" }
                return
            }
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            let arr = (obj["voices"] as? [[String: Any]]) ?? []
            let voices = arr.compactMap { v -> PiperVoice? in
                guard let voice = v["voice"] as? String, let name = v["name"] as? String else { return nil }
                return PiperVoice(
                    voice: voice,
                    name: name,
                    lang: v["lang"] as? String ?? "",
                    flag: v["flag"] as? String ?? "🌐",
                    quality: v["quality"] as? String ?? "",
                    gender: v["gender"] as? String ?? ""
                )
            }
            if engine == "piper" {
                piperVoices = voices
                if !settings.piperVoice.isEmpty, !voices.contains(where: { $0.voice == settings.piperVoice }) {
                    settings.piperVoice = ""
                }
            } else {
                edgeVoices = voices
                if !settings.edgeVoice.isEmpty, !voices.contains(where: { $0.voice == settings.edgeVoice }) {
                    settings.edgeVoice = ""
                }
            }
        } catch {
            let msg = "Fehler: \(error.localizedDescription)"
            if engine == "piper" { piperError = msg } else { edgeError = msg }
        }
    }

    private func qualityLabel(_ q: AVSpeechSynthesisVoiceQuality) -> String {
        switch q {
        case .premium: return "Premium"
        case .enhanced: return "Enhanced"
        default: return "Default"
        }
    }

    private func probe() async {
        probing = true
        probeResult = ""
        defer { probing = false }
        guard let url = URL(string: "\(settings.backendURL)/health") else {
            probeResult = "URL ungültig"; return
        }
        var req = URLRequest(url: url)
        if !settings.authUser.isEmpty {
            let token = "\(settings.authUser):\(settings.authPass)".data(using: .utf8)!.base64EncodedString()
            req.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
        }
        let session = URLSession.shared
        do {
            let (data, resp) = try await session.data(for: req)
            if let http = resp as? HTTPURLResponse {
                let body = String(data: data, encoding: .utf8) ?? ""
                probeResult = "HTTP \(http.statusCode)\n\(body.prefix(200))"
            }
        } catch {
            probeResult = "Fehler: \(error.localizedDescription)"
        }
    }
}

#Preview {
    SettingsView(messages: .constant([]), wake: WakeWordService()).environmentObject(AppSettings())
}
