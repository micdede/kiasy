import SwiftUI

/// State-Maschine für den Orb. Steuert Farbe, Animation-Geschwindigkeiten,
/// Effekte (Schallwellen, Vortex etc.).
enum OrbState {
    case idle        // wartet auf Trigger — gedämpftes Cyan, ruhig
    case listening   // hört zu — Cyan, audio-reaktiv (Mic-Level)
    case thinking    // verarbeitet (sending) — Amber/Gold, Vortex-Effekt, Heartbeat
    case speaking    // spricht — Magenta/Violett, Schallwellen-Pulse + audio-reaktiv

    var primaryColor: Color {
        switch self {
        case .idle:      return Color(hue: 0.53, saturation: 0.55, brightness: 0.85)  // gedämpftes Cyan
        case .listening: return Theme.accent                                            // Tron-Cyan
        case .thinking:  return Color(hue: 0.10, saturation: 0.85, brightness: 1.00)   // warm Amber/Gold
        case .speaking:  return Color(hue: 0.78, saturation: 0.75, brightness: 1.00)   // Magenta-Violett
        }
    }
}

/// Audio-reaktiver Orb mit state-abhängigen visuellen Signaturen.
/// - **Listening**: Particle-Schwarm + waving Wireframe-Sphere reagiert auf Mic
/// - **Thinking**: Vortex (Particles ziehen Spirale rein) + Heartbeat-Core
/// - **Speaking**: zusätzliche Schallwellen-Ringe expandieren von Center
/// - **Idle**: subtiles Atmen
struct OrbView: View {
    let level: Double
    let state: OrbState

    private var tint: Color { state.primaryColor }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1/60, paused: false)) { ctx in
            let now = ctx.date.timeIntervalSinceReferenceDate
            let breath = sin(now * 1.3) * 0.05 + 1.0
            let levelEased = level * 0.7 + Double(sin(now * 8)) * level * 0.05

            // Heartbeat für Thinking — 1.2 Hz "Denken"-Rhythmus mit kurzem Spike
            let heartbeat: Double = {
                guard state == .thinking else { return 0 }
                let t = (now * 1.2).truncatingRemainder(dividingBy: 1.0)
                // Doppel-Beat-Profil (lub-dub): zwei kurze Spikes pro Zyklus
                let spike1 = exp(-pow((t - 0.10) * 9, 2))
                let spike2 = exp(-pow((t - 0.28) * 9, 2)) * 0.6
                return spike1 + spike2
            }()

            // Aktiver "Energie-Level" — kombiniert echtes Audio + Heartbeat
            let energy = max(level, heartbeat * 0.7)
            let coreScale = breath * (1 + energy * 0.5)

            ZStack {
                // ─── 1. Outer Halo ──────────────────────────────────
                Circle()
                    .fill(tint.opacity(0.32 + energy * 0.5))
                    .frame(width: 380, height: 380)
                    .blur(radius: 75)
                    .scaleEffect(breath)

                // ─── 2. Orbital Particle Field ──────────────────────
                Canvas { gctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let particleCount = 42

                    // Im Thinking-State: Particles "saugen" zum Center (Vortex)
                    let vortexPull = state == .thinking
                        ? (sin(now * 0.6) * 0.5 + 0.5) * 0.45  // 0...0.45
                        : 0.0
                    let speedMultiplier: Double = state == .thinking ? 2.4 : 1.0

                    for i in 0..<particleCount {
                        let p = Double(i) / Double(particleCount)
                        let layer = i % 3
                        let layerSpeed = [0.18, -0.12, 0.25][layer] * speedMultiplier
                        let layerR = [148.0, 168.0, 132.0][layer]
                        let layerTilt = [0.92, 0.85, 1.0][layer]

                        let angle = p * .pi * 2 + now * layerSpeed
                        let pulseR = sin(now * 0.9 + p * 6) * 18 * (level + 0.15)
                        // Vortex: Radius schrumpft pulsierend
                        let r = (layerR - vortexPull * layerR * 0.5) + pulseR

                        let x = c.x + cos(angle) * r
                        let y = c.y + sin(angle) * r * layerTilt

                        let depth = (sin(angle) + 1) / 2
                        let dotSize: CGFloat = 1.8 + CGFloat(depth) * 2.5 + CGFloat(energy) * 2
                        let opacity = (0.25 + depth * 0.55) * (energy * 0.6 + 0.5)

                        let dot = CGRect(x: x - dotSize/2, y: y - dotSize/2,
                                         width: dotSize, height: dotSize)
                        gctx.fill(Path(ellipseIn: dot), with: .color(tint.opacity(opacity)))
                    }
                }
                .frame(width: 420, height: 420)
                .blur(radius: 0.4)

                // ─── 3. Wireframe-Sphere (wavy mesh) ────────────────
                Canvas { gctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let baseR: Double = 78
                    let segments = 48
                    let rings = 3
                    // Thinking: dünner, ruhiger, fast nur outline
                    let opacityFactor: Double = state == .thinking ? 0.45 : 1.0

                    for ring in 0..<rings {
                        var path = Path()
                        let rp = Double(ring) / Double(rings - 1)
                        let depthScale = 1.0 - rp * 0.32
                        let yTilt = 0.96 - rp * 0.14

                        for s in 0...segments {
                            let theta = Double(s) / Double(segments) * .pi * 2
                            let wave1 = sin(theta * 4 + now * 1.6 + rp * 2.5) * 9 * (levelEased + 0.18)
                            let wave2 = sin(theta * 7 - now * 2.1 + rp * 1.3) * 5 * (levelEased + 0.12)
                            let wave3 = sin(theta * 11 + now * 0.9) * 3 * level
                            let r = baseR * depthScale + wave1 + wave2 + wave3

                            let x = c.x + cos(theta) * r
                            let y = c.y + sin(theta) * r * yTilt

                            if s == 0 { path.move(to: CGPoint(x: x, y: y)) }
                            else { path.addLine(to: CGPoint(x: x, y: y)) }
                        }
                        path.closeSubpath()

                        let opacity = (0.55 + level * 0.4) * (1.0 - rp * 0.35) * opacityFactor
                        let lineWidth: CGFloat = 1.0 + CGFloat(level) * 0.8
                        gctx.stroke(path, with: .color(tint.opacity(opacity)), lineWidth: lineWidth)
                    }
                }
                .frame(width: 320, height: 320)

                // ─── 4. Radial Beams ────────────────────────────────
                Canvas { gctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let beamCount = 12
                    let inner: Double = 55
                    let outer: Double = 130 + energy * 35
                    // Thinking: kontinuierliche Rotation statt diskreter Pulse
                    let rotationSpeed: Double = state == .thinking ? 0.8 : 0.25

                    for i in 0..<beamCount {
                        let theta = Double(i) / Double(beamCount) * .pi * 2 + now * rotationSpeed
                        let pulse = (sin(now * 3 + Double(i) * 0.6) + 1) / 2
                        let opacity = (0.06 + energy * 0.55) * pulse

                        let x1 = c.x + cos(theta) * inner
                        let y1 = c.y + sin(theta) * inner * 0.93
                        let x2 = c.x + cos(theta) * outer
                        let y2 = c.y + sin(theta) * outer * 0.93

                        var path = Path()
                        path.move(to: CGPoint(x: x1, y: y1))
                        path.addLine(to: CGPoint(x: x2, y: y2))
                        gctx.stroke(path, with: .color(tint.opacity(opacity)),
                                    lineWidth: 0.7 + CGFloat(energy) * 1.0)
                    }
                }
                .frame(width: 320, height: 320)

                // ─── 5. Speaking-Effekt: Schallwellen-Ringe ─────────
                // Konzentrische Ringe wandern von Center nach außen, wie
                // Schallwellen. Audio-Level moduliert Geschwindigkeit + Helligkeit.
                if state == .speaking {
                    Canvas { gctx, size in
                        let c = CGPoint(x: size.width / 2, y: size.height / 2)
                        let waveCount = 4
                        let pulseSpeed: Double = 0.55 + level * 1.1
                        let maxR: Double = 230 * (level + 0.4)

                        for i in 0..<waveCount {
                            let phase = ((now * pulseSpeed) + Double(i) / Double(waveCount))
                                .truncatingRemainder(dividingBy: 1.0)
                            let r = 45 + phase * maxR
                            let opacity = (1 - phase) * (level * 0.85 + 0.25)
                            let lineWidth: CGFloat = 1.5 + CGFloat(level) * 1.8
                            let rect = CGRect(x: c.x - r, y: c.y - r * 0.95,
                                              width: r * 2, height: r * 2 * 0.95)
                            gctx.stroke(Path(ellipseIn: rect),
                                        with: .color(tint.opacity(opacity)), lineWidth: lineWidth)
                        }
                    }
                    .frame(width: 500, height: 500)
                    .blur(radius: 0.5)
                    .transition(.opacity)
                }

                // ─── 6. Plasma Core ────────────────────────────────
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color.white.opacity(0.98),
                                tint.opacity(0.85),
                                tint.opacity(0.0)
                            ],
                            center: UnitPoint(x: 0.42, y: 0.36),
                            startRadius: 3,
                            endRadius: 60
                        )
                    )
                    .frame(width: 95, height: 95)
                    .scaleEffect(coreScale)
                    .shadow(color: tint.opacity(0.85), radius: 22 + 20 * energy)
                    .shadow(color: tint.opacity(0.55), radius: 50 + 35 * energy)

                Circle()
                    .fill(Color.white.opacity(0.55))
                    .frame(width: 22, height: 22)
                    .blur(radius: 8)
                    .offset(x: -16, y: -18)
                    .scaleEffect(coreScale)
            }
            .animation(.easeOut(duration: 0.08), value: level)
            .animation(.easeInOut(duration: 0.5), value: state)
        }
    }
}

#Preview("Listening") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0.5, state: .listening)
    }
}

#Preview("Thinking") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0, state: .thinking)
    }
}

#Preview("Speaking") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0.6, state: .speaking)
    }
}
