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
    @State private var probeResult: String = ""
    @State private var probing = false
    @State private var piperVoices: [PiperVoice] = []
    @State private var piperLoading = false
    @State private var piperError: String?

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
                        Text("Piper (Server)").tag("piper")
                    }
                    if settings.ttsBackend == "ios" {
                        Picker("iOS-Stimme", selection: $settings.ttsVoiceID) {
                            Text("Auto (beste de-DE)").tag("")
                            ForEach(availableVoices, id: \.identifier) { v in
                                Text("\(v.name) — \(qualityLabel(v.quality))").tag(v.identifier)
                            }
                        }
                    } else {
                        Picker("Piper-Stimme", selection: $settings.piperVoice) {
                            Text("Server-Default").tag("")
                            ForEach(piperVoices) { pv in
                                Text("\(pv.flag) \(pv.name) — \(pv.quality)").tag(pv.voice)
                            }
                        }
                        if piperLoading { Text("lade Stimmen…").font(.caption).foregroundStyle(.secondary) }
                        if let err = piperError { Text(err).font(.caption).foregroundStyle(.red) }
                        Button("Stimmen vom Server laden") { Task { await loadPiperVoices() } }
                            .disabled(piperLoading)
                    }
                }
                .task { if settings.ttsBackend == "piper" && piperVoices.isEmpty { await loadPiperVoices() } }
                Section("Über") {
                    LabeledContent("Bundle", value: Bundle.main.bundleIdentifier ?? "?")
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                }
            }
            .navigationTitle("Einstellungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }

    private func loadPiperVoices() async {
        piperLoading = true
        piperError = nil
        defer { piperLoading = false }
        guard let url = URL(string: "\(settings.backendURL)/api/voice/voices") else {
            piperError = "URL ungültig"; return
        }
        var req = URLRequest(url: url)
        if !settings.authUser.isEmpty {
            let token = "\(settings.authUser):\(settings.authPass)".data(using: .utf8)!.base64EncodedString()
            req.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                piperError = "HTTP-Fehler"; return
            }
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            let arr = (obj["voices"] as? [[String: Any]]) ?? []
            piperVoices = arr.compactMap { v in
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
            // Falls die gespeicherte Stimme nicht (mehr) in der Liste ist → leeren
            if !settings.piperVoice.isEmpty,
               !piperVoices.contains(where: { $0.voice == settings.piperVoice }) {
                settings.piperVoice = ""
            }
            // Auto-Default NICHT setzen — sonst rendert der Picker "tag invalid"
            // bevor die Liste da ist. "Server-Default" (leer) bleibt der Initial-Wert.
        } catch {
            piperError = "Fehler: \(error.localizedDescription)"
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
    SettingsView().environmentObject(AppSettings())
}
