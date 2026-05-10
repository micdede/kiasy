import SwiftUI

/// Voice-Mode-Vollbild — kein Chat sichtbar, nur ein animierter Orb der auf
/// Listening / Thinking / Speaking reagiert.
///
/// Zwei Modi:
///   realtimeMode=false  → SpeechService (SFSpeechRecognizer) + TTSService
///   realtimeMode=true   → VoiceStreamService (WebSocket + Whisper + Piper-Streaming)
struct ConversationView: View {
    @EnvironmentObject var settings: AppSettings
    @ObservedObject var speech:      SpeechService
    @ObservedObject var tts:         TTSService
    @ObservedObject var voiceStream: VoiceStreamService
    @Binding var sending: Bool
    @Environment(\.dismiss) private var dismiss

    @State private var previousConversationMode: Bool = false

    // MARK: - Computed State

    private var orbState: OrbState {
        if settings.realtimeMode {
            switch voiceStream.state {
            case .listening:  return .listening
            case .processing: return .thinking
            case .speaking:   return .speaking
            case .idle:       return .idle
            }
        }
        if speech.isListening { return .listening }
        if tts.isSpeaking     { return .speaking }
        if sending            { return .thinking }
        return .idle
    }

    private var orbLevel: Double {
        if settings.realtimeMode {
            switch voiceStream.state {
            case .listening: return Double(voiceStream.inputLevel)
            case .speaking:  return Double(voiceStream.outputLevel)
            default:         return 0
            }
        }
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

    private var transcriptText: String? {
        if settings.realtimeMode {
            return voiceStream.state == .listening && !voiceStream.latestTranscript.isEmpty
                ? voiceStream.latestTranscript : nil
        }
        return speech.isListening && !speech.transcript.isEmpty ? speech.transcript : nil
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
                    .padding(.top, 24)
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
            voiceStream.startListening()
        } else {
            Task { @MainActor in
                let ok = await speech.requestPermissions()
                guard ok, !speech.isListening, !tts.isSpeaking else { return }
                speech.start(silenceTimeout: 6)
            }
        }
    }

    private func onDisappear() {
        settings.conversationMode = previousConversationMode
        if settings.realtimeMode {
            voiceStream.stopAll()
        } else {
            speech.stop()
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
        if settings.realtimeMode {
            switch voiceStream.state {
            case .listening:  voiceStream.stopListening()
            case .speaking:   voiceStream.stopAll()
            case .processing: return  // läuft — nicht interruptieren
            case .idle:       voiceStream.startListening()
            }
        } else {
            if speech.isListening {
                speech.stop()
            } else if tts.isSpeaking {
                tts.stop()
            } else if sending {
                return
            } else {
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
            guard settings.conversationMode,
                  voiceStream.state == .idle else { return }
            voiceStream.startListening()
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
}

#Preview {
    ConversationView(
        speech: SpeechService(), tts: TTSService(),
        voiceStream: VoiceStreamService(), sending: .constant(false)
    ).environmentObject(AppSettings())
}
