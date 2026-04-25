import SwiftUI
import AppKit
import AVFoundation

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var capturing = false
    @State private var captureMonitor: Any?
    @State private var capturingDialog = false
    @State private var captureDialogMonitor: Any?

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
                Toggle("Apple-Spracherkennung (statt Whisper-Server)", isOn: $state.useLocalSTT)
                Toggle("Apple-Sprachausgabe (statt Server-TTS / Piper)", isOn: $state.useLocalTTS)
                Text("STT und TTS sind unabhängig schaltbar. Apple = on-device, sofort. Server-TTS nutzt aktuell Piper (lokaler Neural-TTS auf Unraid) — natürlicher klingend als Apple, +200-500ms Latenz.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if state.useLocalTTS {
                    voicePicker
                } else {
                    piperVoicePicker
                }

                speedSlider

                Divider()

                Text("Hotkeys").font(.headline)

                Text("Fenster öffnen/schließen").font(.caption).foregroundColor(.secondary)
                HStack {
                    Toggle("aktiv", isOn: $state.hotkeyEnabled).labelsHidden()
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

                Text("Dialog starten/stoppen").font(.caption).foregroundColor(.secondary)
                HStack {
                    Toggle("aktiv", isOn: $state.dialogHotkeyEnabled).labelsHidden()
                    Text(state.dialogHotkeyDisplay)
                        .font(.system(.body, design: .monospaced))
                        .padding(.vertical, 4)
                        .padding(.horizontal, 10)
                        .background(Color.gray.opacity(0.18))
                        .cornerRadius(6)
                    Spacer()
                    Button(capturingDialog ? "Drücke eine Taste…" : "Ändern") {
                        capturingDialog ? stopDialogCapture() : startDialogCapture()
                    }
                    .disabled(!state.dialogHotkeyEnabled)
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
        .onDisappear { stopCapture(); stopDialogCapture() }
    }

    private var speedSlider: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Sprechtempo").font(.caption).foregroundColor(.secondary)
                Spacer()
                Text(String(format: "%.2f×", state.ttsSpeed))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
            }
            HStack {
                Text("0.7×").font(.caption2).foregroundColor(.secondary)
                Slider(value: $state.ttsSpeed, in: 0.7...1.5, step: 0.05)
                Text("1.5×").font(.caption2).foregroundColor(.secondary)
                Button {
                    state.ttsSpeed = 1.0
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(.borderless)
                .help("Auf 1.0× zurücksetzen")
            }
        }
    }

    private var piperVoicePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Piper-Stimme").font(.caption).foregroundColor(.secondary)
            HStack {
                Picker("", selection: $state.piperVoice) {
                    Text("Server-Default").tag("")
                    ForEach(state.piperVoices) { voice in
                        Text(voice.description).tag(voice.name)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity)

                Button {
                    let v = state.piperVoice.isEmpty ? (state.piperVoices.first?.name ?? "") : state.piperVoice
                    if !v.isEmpty { state.previewPiperVoice(v) }
                } label: {
                    Image(systemName: "play.circle")
                }
                .buttonStyle(.borderless)
                .help("Stimme testen")
                .disabled(state.piperVoices.isEmpty)
            }
            if state.piperVoices.isEmpty {
                Text("Keine Piper-Stimmen geladen — prüfe ob PIPER_HOST am Server gesetzt ist.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Empfehlung: thorsten-medium (schnell, klar) oder thorsten-high (langsamer, natürlicher).")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { if state.piperVoices.isEmpty { await state.loadPiperVoices() } }
    }

    private var voicePicker: some View {
        let voices = NativeSpeechSynth.germanVoices()
        return VStack(alignment: .leading, spacing: 4) {
            Text("Stimme").font(.caption).foregroundColor(.secondary)
            HStack {
                Picker("", selection: $state.nativeVoiceId) {
                    Text("Automatisch (beste verfügbare)").tag("")
                    ForEach(voices, id: \.identifier) { voice in
                        Text("\(voice.name) — \(voice.quality.label)").tag(voice.identifier)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity)

                Button {
                    state.nativeSynth.preview()
                } label: {
                    Image(systemName: "play.circle")
                }
                .buttonStyle(.borderless)
                .help("Stimme testen")
            }
            if voices.isEmpty {
                Text("Keine deutschen Stimmen installiert. Mehr unter Systemeinstellungen → Bedienungshilfen → Vorlesen → Systemstimmen.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Premium-/Siri-Stimmen sind die natürlichsten — runterladbar via Systemeinstellungen → Bedienungshilfen → Vorlesen.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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

    private func startDialogCapture() {
        capturingDialog = true
        captureDialogMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { // Esc bricht ab
                stopDialogCapture()
                return nil
            }
            let mods = event.modifierFlags.intersection(KeyMapper.relevantModifierMask)
            state.dialogHotkeyKeyCode = Int(event.keyCode)
            state.dialogHotkeyModifiers = Int(mods.rawValue)
            stopDialogCapture()
            return nil
        }
    }

    private func stopDialogCapture() {
        if let m = captureDialogMonitor { NSEvent.removeMonitor(m); captureDialogMonitor = nil }
        capturingDialog = false
    }
}
