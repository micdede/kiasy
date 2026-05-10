import SwiftUI

/// Voice-Mode-Vollbild — kein Chat sichtbar, nur ein animierter Orb der auf
/// Listening / Thinking / Speaking reagiert.
///
/// Zwei Modi:
///   realtimeMode=false  → SpeechService (SFSpeechRecognizer) + TTSService
///   realtimeMode=true   → VoiceStreamService (WebSocket + Whisper + Piper-Streaming)
private let thinkingPhrases: [String] = [
    // technisch-selbstbewusst
    "Kalkuliere…", "Optimiere Antwort…", "Neuronales Netz warm…",
    "Verarbeite Eingabe…", "Inferenz läuft…", "Tokenisiere Gedanken…",
    "Aktiviere Denkapparat…", "Quantifiziere Möglichkeiten…",
    "Mustererkennung aktiv…", "Semantik wird analysiert…",
    "Kontextualisiere…", "Gewichte Parameter…",
    // launig / witzig
    "Frage Deep Thought…", "Zähle zu 42…", "Kratze virtuellen Kopf…",
    "Frage Tony Stark…", "Konsultiere das Orakel…", "Lese Teeblätter…",
    "Schau in die Kristallkugel…", "Befrage die Götter…",
    "Würfle mit dem Universum…", "Bitte kurz um Ruhe…",
    "Aktiviere Turbo-Hirn…", "Starte Gedankenprotokoll…",
    "Lade Weisheit hoch…", "Kompiliere Klugheit…",
    "Suche in allen Paralleluniversen…", "Frage Sherlock…",
    "Konsultiere Einstein…", "Wühle im Wissensschatz…",
    "Philosophiere kurz…", "Taste die Existenz…",
    // dramatisch
    "Durchforste das Universum…", "Ergründe die Tiefen…",
    "Durchleuchte die Frage…", "Scanme Wissensmatrix…",
    "Überbrücke neuronale Synapsen…", "Entfalte Denkfalten…",
    "Streife durch Datennebel…", "Tauche in Informationsozean…",
    // nüchtern / ehrlich
    "Hm.", "Gute Frage.", "Kommt drauf an…", "Interessant.",
    "Einen Moment.", "Ich überlege.", "Fast fertig…", "Gleich.",
    "Noch ein Augenblick…", "Kurz bitte…",
    // JARVIS-spezifisch
    "Initiiere Denksequenz…", "JARVIS denkt nach…",
    "Hauptprozessor bei 100%…", "Lade besten Gedanken…",
    "Bin gleich zurück…", "Synapse feuert…",
]

struct ConversationView: View {
    @EnvironmentObject var settings: AppSettings
    @ObservedObject var speech:      SpeechService
    @ObservedObject var tts:         TTSService
    @ObservedObject var voiceStream: VoiceStreamService
    @Binding var sending: Bool
    @Environment(\.dismiss) private var dismiss

    @State private var previousConversationMode: Bool = false
    @State private var thinkingWord: String = "Kalkuliere…"
    @State private var thinkingWordVisible: Bool = true
    @State private var thinkingTask: Task<Void, Never>? = nil

    // MARK: - Computed State

    // Im Realtime-Modus: SpeechService für Mic/Stille, VoiceStreamService für TTS
    private var orbState: OrbState {
        if speech.isListening                         { return .listening }
        if settings.realtimeMode {
            if voiceStream.state == .processing       { return .thinking }
            if voiceStream.state == .speaking         { return .speaking }
        } else {
            if tts.isSpeaking                         { return .speaking }
            if sending                                { return .thinking }
        }
        return .idle
    }

    private var orbLevel: Double {
        if speech.isListening { return Double(speech.inputLevel) }
        if settings.realtimeMode {
            return voiceStream.state == .speaking ? Double(voiceStream.outputLevel) : 0
        }
        return tts.isSpeaking ? Double(tts.outputLevel) : 0
    }

    private var statusText: String {
        switch orbState {
        case .idle:      return "warte auf dich…"
        case .listening: return "ich höre…"
        case .thinking:  return thinkingWord
        case .speaking:  return "ich spreche…"
        }
    }

    private var transcriptText: String? {
        guard speech.isListening, !speech.transcript.isEmpty else { return nil }
        return speech.transcript
    }

    // MARK: - Body

    var body: some View {
        ZStack {
            Theme.bgDeep.ignoresSafeArea()
            RadialGradient(
                colors: [Theme.accent.opacity(0.10), .clear],
                center: .center, startRadius: 50, endRadius: 400
            ).ignoresSafeArea()

            VStack(spacing: 0) {
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
                .padding(.horizontal, 18).padding(.top, 12)

                Spacer()

                OrbView(
                    level: orbLevel,
                    state: orbState,
                    style: OrbStyle(rawValue: settings.orbStyle) ?? .sphere,
                    shape: ParticleShape(rawValue: settings.particleShape) ?? .circle
                )
                .frame(width: 360, height: 360)

                Text(statusText)
                    .font(.system(size: 18, weight: .medium, design: .monospaced))
                    .tracking(0.5)
                    .foregroundStyle(orbState.primaryColor)
                    .shadow(color: orbState.primaryColor.opacity(0.5), radius: 6)
                    .opacity(thinkingWordVisible ? 1 : 0)
                    .padding(.top, 24)
                    .animation(.easeInOut(duration: 0.35), value: thinkingWordVisible)
                    .animation(.easeInOut(duration: 0.3), value: statusText)

                if let t = transcriptText {
                    Text(t)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(Theme.textDim)
                        .lineLimit(2).multilineTextAlignment(.center)
                        .padding(.horizontal, 32).padding(.top, 12)
                        .transition(.opacity)
                }

                Spacer()

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
        .onAppear { onAppear() }
        .onDisappear { onDisappear() }
        .onChange(of: orbState) { _, newState in
            if newState == .thinking {
                startThinkingCycle()
            } else {
                stopThinkingCycle()
            }
        }
        // Realtime-Modus: nach jedem Turn automatisch wieder Mic auf
        .onChange(of: voiceStream.turnFinished) { _, _ in
            if settings.realtimeMode && settings.conversationMode {
                autoRestart()
            }
        }
        // Fallback-Modus: TTS-Ende → Mic wieder auf
        .onChange(of: tts.isSpeaking) { _, speaking in
            if !settings.realtimeMode && !speaking && settings.conversationMode {
                autoRestartLegacy()
            }
        }
    }

    // MARK: - Lifecycle

    private func onAppear() {
        previousConversationMode = settings.conversationMode
        settings.conversationMode = true
        if settings.realtimeMode {
            // WebSocket reconnecten falls zuvor getrennt (z.B. nach Fehler)
            voiceStream.connect(settings: settings)
        }
        Task { @MainActor in
            let ok = await speech.requestPermissions()
            guard ok, !speech.isListening else { return }
            if settings.realtimeMode {
                // 2.5s damit der User in Ruhe anfangen kann zu sprechen
                speech.start(silenceTimeout: 2.5)
            } else {
                guard !tts.isSpeaking else { return }
                speech.start(silenceTimeout: 6)
            }
        }
    }

    private func onDisappear() {
        settings.conversationMode = previousConversationMode
        speech.stop()
        if settings.realtimeMode {
            voiceStream.disconnect()  // WebSocket sauber schließen
        } else {
            tts.stop()
        }
    }

    // MARK: - Main Action Button

    private var mainActionIcon: String {
        switch orbState {
        case .listening: return "stop.fill"
        case .speaking:  return "speaker.slash.fill"
        case .thinking:  return "ellipsis"
        case .idle:      return "mic.fill"
        }
    }

    private var mainActionColor: Color {
        switch orbState {
        case .listening: return Theme.err
        case .speaking:  return Theme.warn
        case .thinking:  return orbState.primaryColor.opacity(0.6)
        case .idle:      return Theme.accent
        }
    }

    private func tapMainAction() {
        if speech.isListening {
            speech.stop()  // im Realtime-Modus → ContentView.onChange sendet Text per WS
        } else if settings.realtimeMode {
            if voiceStream.state == .speaking {
                voiceStream.cancelTurn()
            } else if voiceStream.state == .processing {
                return
            } else {
                speech.start(silenceTimeout: 1.5)
            }
        } else {
            if tts.isSpeaking { tts.stop() }
            else if sending   { return }
            else {
                Task { @MainActor in
                    let ok = await speech.requestPermissions()
                    guard ok else { return }
                    speech.start(silenceTimeout: 6)
                }
            }
        }
    }

    // MARK: - Auto-Continue

    private func autoRestart() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard settings.conversationMode, !speech.isListening,
                  voiceStream.state == .idle else { return }
            speech.start(silenceTimeout: 1.5)
        }
    }

    private func autoRestartLegacy() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard settings.conversationMode,
                  !speech.isListening, !sending, !tts.isSpeaking else { return }
            speech.start(silenceTimeout: 6)
        }
    }

    // MARK: - Thinking Cycle

    private func startThinkingCycle() {
        thinkingTask?.cancel()
        thinkingWord = thinkingPhrases.randomElement() ?? "Kalkuliere…"
        thinkingWordVisible = true
        thinkingTask = Task { @MainActor in
            var used: Set<String> = [thinkingWord]
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                guard !Task.isCancelled else { break }
                // Fade out
                thinkingWordVisible = false
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else { break }
                // Pick next phrase — avoid immediate repeats, reset pool when exhausted
                if used.count >= thinkingPhrases.count { used.removeAll() }
                let next = thinkingPhrases.filter { !used.contains($0) }.randomElement()
                    ?? thinkingPhrases.randomElement()
                    ?? thinkingWord
                used.insert(next)
                thinkingWord = next
                // Fade in
                thinkingWordVisible = true
            }
        }
    }

    private func stopThinkingCycle() {
        thinkingTask?.cancel()
        thinkingTask = nil
        thinkingWordVisible = true
    }
}

#Preview {
    ConversationView(
        speech: SpeechService(), tts: TTSService(),
        voiceStream: VoiceStreamService(), sending: .constant(false)
    ).environmentObject(AppSettings())
}
