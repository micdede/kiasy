import SwiftUI

/// Voice-Mode-Vollbild — kein Chat sichtbar, nur ein animierter Orb der auf
/// Listening/Speaking reagiert. Konversations-Modus wird beim Öffnen aktiviert
/// und beim Schließen auf den vorherigen Wert zurückgesetzt.
struct ConversationView: View {
    @EnvironmentObject var settings: AppSettings
    @ObservedObject var speech: SpeechService
    @ObservedObject var tts: TTSService
    @Environment(\.dismiss) private var dismiss

    /// Vorheriger Conversation-Mode-State, damit das Verlassen das Setting
    /// nicht permanent verändert.
    @State private var previousConversationMode: Bool = false

    var body: some View {
        ZStack {
            // ─── Background mit dezentem Vignette ───────────────
            Theme.bgDeep.ignoresSafeArea()
            RadialGradient(
                colors: [orbTint.opacity(0.08), .clear],
                center: .center,
                startRadius: 50,
                endRadius: 400
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Top-Bar
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(Theme.text)
                            .frame(width: 38, height: 38)
                            .background(Theme.bgCard)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Theme.bgHairline, lineWidth: 0.8))
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 12)

                Spacer()

                // ─── Orb ──────────────────────────────────────────
                OrbView(level: orbLevel, tint: orbTint)
                    .frame(width: 360, height: 360)

                // ─── Status-Text ──────────────────────────────────
                Text(statusText)
                    .font(.system(size: 18, weight: .medium, design: .monospaced))
                    .tracking(0.5)
                    .foregroundStyle(statusColor)
                    .shadow(color: statusColor.opacity(0.5), radius: 6)
                    .padding(.top, 24)
                    .animation(.easeInOut(duration: 0.2), value: statusText)

                // Live-Transkript klein darunter (während Listening)
                if speech.isListening, !speech.transcript.isEmpty {
                    Text(speech.transcript)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(Theme.textDim)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 12)
                        .transition(.opacity)
                }

                Spacer()

                // ─── Stop / Toggle Button ─────────────────────────
                Button { tapMainAction() } label: {
                    Image(systemName: mainActionIcon)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 76, height: 76)
                        .background(mainActionColor)
                        .clipShape(Circle())
                        .shadow(color: mainActionColor.opacity(0.7), radius: 16)
                }
                .padding(.bottom, 50)
                .animation(.easeInOut(duration: 0.2), value: speech.isListening)
                .animation(.easeInOut(duration: 0.2), value: tts.isSpeaking)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            previousConversationMode = settings.conversationMode
            settings.conversationMode = true
            // Mic auto-start sobald die View da ist
            Task { @MainActor in
                let ok = await speech.requestPermissions()
                guard ok, !speech.isListening, !tts.isSpeaking else { return }
                speech.start(silenceTimeout: 6)
            }
        }
        .onDisappear {
            settings.conversationMode = previousConversationMode
            speech.stop()
            tts.stop()
        }
    }

    // ─── Computed: Visualisierung-State ──────────────────────
    private var orbLevel: Double {
        if speech.isListening { return Double(speech.inputLevel) }
        if tts.isSpeaking     { return Double(tts.outputLevel) }
        return 0
    }

    /// Cyan beim Listening, leicht violett-blau beim Speaking, gedämpftes Cyan idle.
    private var orbTint: Color {
        if speech.isListening { return Theme.accent }
        if tts.isSpeaking     { return Color(hue: 0.62, saturation: 0.78, brightness: 1.0) }
        return Theme.accent.opacity(0.55)
    }

    private var statusText: String {
        if speech.isListening { return "ich höre…" }
        if tts.isSpeaking     { return "ich spreche…" }
        return "warte auf dich…"
    }

    private var statusColor: Color {
        if speech.isListening { return Theme.accent }
        if tts.isSpeaking     { return Color(hue: 0.62, saturation: 0.7, brightness: 1.0) }
        return Theme.textDim
    }

    // ─── Main Action Button ───────────────────────────────────
    private var mainActionIcon: String {
        if speech.isListening { return "stop.fill" }
        if tts.isSpeaking     { return "speaker.slash.fill" }
        return "mic.fill"
    }

    private var mainActionColor: Color {
        if speech.isListening { return Theme.err }
        if tts.isSpeaking     { return Theme.warn }
        return Theme.accent
    }

    private func tapMainAction() {
        if speech.isListening {
            speech.stop()  // löst Auto-Send via Observer im Parent aus
        } else if tts.isSpeaking {
            tts.stop()  // Konversations-Modus startet das Mic dann automatisch
        } else {
            // Idle → Mic manuell triggern
            Task { @MainActor in
                let ok = await speech.requestPermissions()
                guard ok else { return }
                speech.start(silenceTimeout: 6)
            }
        }
    }
}

#Preview {
    ConversationView(speech: SpeechService(), tts: TTSService())
        .environmentObject(AppSettings())
}
