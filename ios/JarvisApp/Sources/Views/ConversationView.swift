import SwiftUI

/// Voice-Mode-Vollbild — kein Chat sichtbar, nur ein animierter Orb der auf
/// Listening / Thinking / Speaking reagiert. Konversations-Modus wird beim
/// Öffnen aktiviert und beim Schließen auf den vorherigen Wert zurückgesetzt.
struct ConversationView: View {
    @EnvironmentObject var settings: AppSettings
    @ObservedObject var speech: SpeechService
    @ObservedObject var tts: TTSService
    /// Vom Parent (ContentView) durchgereicht — true zwischen Mic-Stop und
    /// TTS-Start, das ist die "Thinking"-Phase
    @Binding var sending: Bool
    @Environment(\.dismiss) private var dismiss

    /// Vorheriger Conversation-Mode-State, damit das Verlassen das Setting
    /// nicht permanent verändert.
    @State private var previousConversationMode: Bool = false

    /// State-Maschine: bestimmt Farbe/Animation des Orbs + Status-Text
    private var orbState: OrbState {
        if speech.isListening { return .listening }
        if tts.isSpeaking     { return .speaking }
        if sending            { return .thinking }
        return .idle
    }

    var body: some View {
        ZStack {
            // ─── Background — Cyan-Vignette, state-unabhängig ──────
            Theme.bgDeep.ignoresSafeArea()
            RadialGradient(
                colors: [Theme.accent.opacity(0.10), .clear],
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
                OrbView(level: orbLevel, state: orbState)
                    .frame(width: 360, height: 360)

                // ─── Status-Text ──────────────────────────────────
                Text(statusText)
                    .font(.system(size: 18, weight: .medium, design: .monospaced))
                    .tracking(0.5)
                    .foregroundStyle(orbState.primaryColor)
                    .shadow(color: orbState.primaryColor.opacity(0.5), radius: 6)
                    .padding(.top, 24)
                    .animation(.easeInOut(duration: 0.3), value: statusText)

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
                .animation(.easeInOut(duration: 0.2), value: orbState)
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

    private var statusText: String {
        switch orbState {
        case .idle:      return "warte auf dich…"
        case .listening: return "ich höre…"
        case .thinking:  return "ich denke nach…"
        case .speaking:  return "ich spreche…"
        }
    }

    // ─── Main Action Button ───────────────────────────────────
    private var mainActionIcon: String {
        if speech.isListening { return "stop.fill" }
        if tts.isSpeaking     { return "speaker.slash.fill" }
        if sending            { return "ellipsis" }
        return "mic.fill"
    }

    private var mainActionColor: Color {
        if speech.isListening { return Theme.err }
        if tts.isSpeaking     { return Theme.warn }
        if sending            { return orbState.primaryColor.opacity(0.6) }
        return Theme.accent
    }

    private func tapMainAction() {
        if speech.isListening {
            speech.stop()  // löst Auto-Send via Observer im Parent aus
        } else if tts.isSpeaking {
            tts.stop()  // Konversations-Modus startet das Mic dann automatisch
        } else if sending {
            // im Thinking-State Tap = nichts (Anfrage läuft)
            return
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
    ConversationView(speech: SpeechService(), tts: TTSService(), sending: .constant(false))
        .environmentObject(AppSettings())
}
