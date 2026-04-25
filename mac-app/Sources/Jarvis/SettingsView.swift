import SwiftUI
import AppKit

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var capturing = false
    @State private var captureMonitor: Any?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Verbindung").font(.headline)

                field("Server-URL", text: $state.serverURL,
                      placeholder: "https://192.168.178.x:3333")
                field("Benutzername", text: $state.username,
                      placeholder: "MONITOR_USER")
                secureField("Passwort", text: $state.password,
                            placeholder: "MONITOR_PASS")

                Divider()

                Text("Fenstergröße").font(.headline)
                HStack(spacing: 8) {
                    sizeButton("Klein",  w: 420, h: 540)
                    sizeButton("Mittel", w: 520, h: 680)
                    sizeButton("Groß",   w: 680, h: 820)
                    sizeButton("Sehr groß", w: 820, h: 960)
                }

                Divider()

                Text("Sprachverarbeitung").font(.headline)
                Toggle("Lokale Apple-STT/TTS (Dialog-Modus)", isOn: $state.useLocalSpeech)
                Text("Spracherkennung & -ausgabe laufen on-device. Kein Whisper-/Edge-TTS-Roundtrip — schnellerer, flüssigerer Dialog. Text wird trotzdem an JARVIS gesendet.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Divider()

                Text("Hotkey").font(.headline)
                HStack {
                    Toggle("Globaler Hotkey aktiv", isOn: $state.hotkeyEnabled)
                    Spacer()
                }
                HStack {
                    Text(state.hotkeyDisplay)
                        .font(.system(.body, design: .monospaced))
                        .padding(.vertical, 4)
                        .padding(.horizontal, 10)
                        .background(Color.gray.opacity(0.18))
                        .cornerRadius(6)
                    Spacer()
                    Button(capturing ? "Drücke eine Taste…" : "Ändern") {
                        capturing ? stopCapture() : startCapture()
                    }
                    .disabled(!state.hotkeyEnabled)
                }

                if let err = state.lastError {
                    Text(err)
                        .font(.caption)
                        .foregroundColor(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack {
                    Button("Verbindung testen") {
                        Task { await state.loadHistory() }
                    }
                    .disabled(!state.isConfigured)

                    Spacer()

                    Button("Schließen") {
                        state.showingSettings = false
                    }
                    .disabled(!state.isConfigured)
                    .keyboardShortcut(.defaultAction)
                }
                .padding(.top, 4)
            }
            .padding(12)
        }
        .onDisappear { stopCapture() }
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundColor(.secondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
        }
    }

    @ViewBuilder
    private func secureField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundColor(.secondary)
            SecureField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
        }
    }

    @ViewBuilder
    private func sizeButton(_ label: String, w: CGFloat, h: CGFloat) -> some View {
        let curW = UserDefaults.standard.object(forKey: "popoverWidth") as? Double ?? 520
        let active = Int(curW) == Int(w)
        Button(label) {
            UserDefaults.standard.set(Double(w), forKey: "popoverWidth")
            UserDefaults.standard.set(Double(h), forKey: "popoverHeight")
            NotificationCenter.default.post(
                name: .jarvisResizePopover,
                object: nil,
                userInfo: ["w": w, "h": h]
            )
        }
        .buttonStyle(.bordered)
        .tint(active ? .accentColor : .secondary)
    }

    private func startCapture() {
        capturing = true
        captureMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // Esc bricht ab, ohne zu speichern
            if event.keyCode == 53 {
                stopCapture()
                return nil
            }
            let mods = event.modifierFlags.intersection(KeyMapper.relevantModifierMask)
            state.hotkeyKeyCode = Int(event.keyCode)
            state.hotkeyModifiers = Int(mods.rawValue)
            stopCapture()
            return nil
        }
    }

    private func stopCapture() {
        if let m = captureMonitor { NSEvent.removeMonitor(m); captureMonitor = nil }
        capturing = false
    }
}
