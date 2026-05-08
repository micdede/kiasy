import SwiftUI
import AVFoundation

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @State private var probeResult: String = ""
    @State private var probing = false

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
                    Picker("Stimme", selection: $settings.ttsVoice) {
                        Text("System (de-DE)").tag("de-DE")
                        ForEach(availableVoices, id: \.identifier) { v in
                            Text("\(v.name) — \(v.language) [\(qualityLabel(v.quality))]").tag(v.language)
                        }
                    }
                }
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
        let session = URLSession(configuration: .default, delegate: TrustAllDelegate(), delegateQueue: nil)
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

private final class TrustAllDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ s: URLSession, didReceive c: URLAuthenticationChallenge,
                    completionHandler h: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if c.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = c.protectionSpace.serverTrust {
            h(.useCredential, URLCredential(trust: trust))
        } else { h(.performDefaultHandling, nil) }
    }
}

#Preview {
    SettingsView().environmentObject(AppSettings())
}
