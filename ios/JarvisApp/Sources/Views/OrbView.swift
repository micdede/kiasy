import SwiftUI

/// State-Maschine für den Orb. Steuert die Particle-Farbe.
enum OrbState {
    case idle        // wartet auf Trigger — gedämpftes Weiß
    case listening   // hört zu — weiß
    case thinking    // verarbeitet — grau
    case speaking    // spricht — Cyan

    var primaryColor: Color {
        switch self {
        case .idle:      return Color.white.opacity(0.5)
        case .listening: return Color.white
        case .thinking:  return Color(white: 0.55)
        case .speaking:  return Theme.accent
        }
    }
}

/// Visualisierungs-Stil — wird über Settings gewählt.
enum OrbStyle: String {
    case sphere    = "sphere"     // Fibonacci-Sphere die rotiert + atmet
    case blackHole = "blackhole"  // Akkretionsscheibe mit Event-Horizon
}

/// Particle-Form — wird über Settings gewählt.
enum ParticleShape: String, CaseIterable {
    case circle, square, diamond, star

    var label: String {
        switch self {
        case .circle:  return "Kreis"
        case .square:  return "Quadrat"
        case .diamond: return "Diamant"
        case .star:    return "Stern"
        }
    }

    /// Erzeugt einen Path für einen Particle der gegebenen Form an `center` mit `size`.
    func path(at center: CGPoint, size: CGFloat) -> Path {
        let s = size
        switch self {
        case .circle:
            return Path(ellipseIn: CGRect(x: center.x - s/2, y: center.y - s/2,
                                          width: s, height: s))
        case .square:
            return Path(CGRect(x: center.x - s/2, y: center.y - s/2,
                               width: s, height: s))
        case .diamond:
            var p = Path()
            p.move(to: CGPoint(x: center.x, y: center.y - s/2))
            p.addLine(to: CGPoint(x: center.x + s/2, y: center.y))
            p.addLine(to: CGPoint(x: center.x, y: center.y + s/2))
            p.addLine(to: CGPoint(x: center.x - s/2, y: center.y))
            p.closeSubpath()
            return p
        case .star:
            var p = Path()
            let outer = s / 2
            let inner = s * 0.22
            for i in 0..<10 {
                let angle = Double(i) * .pi / 5 - .pi / 2
                let r = i % 2 == 0 ? outer : inner
                let x = center.x + cos(angle) * r
                let y = center.y + sin(angle) * r
                if i == 0 { p.move(to: CGPoint(x: x, y: y)) }
                else      { p.addLine(to: CGPoint(x: x, y: y)) }
            }
            p.closeSubpath()
            return p
        }
    }
}

/// Audio-reaktiver Particle-Orb. Zwei Stile (`OrbStyle`):
/// - **sphere**: 400 Punkte auf rotierender Fibonacci-Sphere mit Pseudo-3D-Tiefe
/// - **blackHole**: Akkretionsscheibe (oval, flach) mit Event-Horizon. Per State:
///   listening = Punkte spiralen rein, thinking = stabile Rotation,
///   speaking = Punkte spiralen raus.
struct OrbView: View {
    let level: Double
    let state: OrbState
    let style: OrbStyle
    let shape: ParticleShape

    private let particleCount = 400

    private var particleColor: Color { state.primaryColor }
    private var haloColor: Color { Theme.accent }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1/60, paused: false)) { ctx in
            let now = ctx.date.timeIntervalSinceReferenceDate
            let breath = sin(now * 1.3) * 0.04 + 1.0

            ZStack {
                // Cyan-Halo, immer
                Circle()
                    .fill(haloColor.opacity(0.28 + level * 0.4))
                    .frame(width: 360, height: 360)
                    .blur(radius: 75)
                    .scaleEffect(breath)

                // Particle-Field
                Canvas { gctx, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    for i in 0..<particleCount {
                        let p = particle(index: i, now: now, center: center)
                        let path = shape.path(at: p.position, size: p.size)
                        gctx.fill(path, with: .color(particleColor.opacity(p.opacity)))
                    }
                }
                .frame(width: 500, height: 500)
                .blur(radius: 0.5)

                // Black-Hole-Modus: Event-Horizon (dunkler Kreis mit Cyan-Photon-Ring)
                if style == .blackHole {
                    eventHorizon(breath: breath)
                }
            }
            .animation(.easeInOut(duration: 0.6), value: state)
            .animation(.easeInOut(duration: 0.6), value: style)
        }
    }

    // ─── Event-Horizon (Black-Hole) ──────────────────────────
    @ViewBuilder
    private func eventHorizon(breath: Double) -> some View {
        ZStack {
            // Photon-Ring (heller Cyan-Glow um den dunklen Kern)
            Circle()
                .stroke(haloColor.opacity(0.85), lineWidth: 2.5)
                .frame(width: 38, height: 38 * 0.4)  // sehr flaches Oval
                .blur(radius: 1.5)
                .shadow(color: haloColor.opacity(0.9), radius: 12)

            // Event Horizon — schwarzer Kern
            Ellipse()
                .fill(Color.black)
                .frame(width: 32, height: 32 * 0.4)
                .shadow(color: Color.black, radius: 8)
        }
        .scaleEffect(breath)
    }

    // MARK: - Particle-Berechnung

    private struct Particle {
        let position: CGPoint
        let size: CGFloat
        let opacity: Double
    }

    private func particle(index: Int, now: Double, center: CGPoint) -> Particle {
        switch style {
        case .sphere:    return sphereParticle(index: index, now: now, center: center)
        case .blackHole: return blackHoleParticle(index: index, now: now, center: center)
        }
    }

    /// Fibonacci-Sphere — gleichmäßige Verteilung von N Punkten auf einer Kugeloberfläche.
    /// Wird sanft rotiert (Y-Achse) und atmet; Audio-Level moduliert Wabern.
    private func sphereParticle(index: Int, now: Double, center: CGPoint) -> Particle {
        let n = Double(particleCount)
        let i = Double(index)
        let goldenAngle = .pi * (3.0 - sqrt(5.0))
        let y = 1.0 - (i / (n - 1)) * 2.0
        let radiusAtY = sqrt(1.0 - y * y)
        let theta = goldenAngle * i + now * 0.18
        let xUnit = cos(theta) * radiusAtY
        let zUnit = sin(theta) * radiusAtY

        let wave = sin(now * 2.5 + i * 0.4) * 0.04 * (level + 0.15)
        let breath = sin(now * 1.2) * 0.03 + 1.0
        let r: Double = 105.0 * (breath + wave)

        let px = center.x + xUnit * r
        let py = center.y + y * r * 0.95

        let depth = (zUnit + 1) / 2
        let opacity = (0.15 + depth * 0.7) * (level * 0.5 + 0.55)
        let size = CGFloat(1.4 + depth * 2.0 + level * 1.5)

        return Particle(position: CGPoint(x: px, y: py), size: size, opacity: opacity)
    }

    /// Black-Hole / Akkretionsscheibe — flache, ovale Scheibe mit Event-Horizon.
    /// State steuert Fluss-Richtung:
    /// - listening: Punkte spiralen rein zum Horizon
    /// - thinking: stabile Rotation auf konzentrischen Bahnen (Uhrzeigersinn)
    /// - speaking: Punkte spiralen vom Horizon raus
    private func blackHoleParticle(index: Int, now: Double, center: CGPoint) -> Particle {
        let i = Double(index)
        let n = Double(particleCount)
        let diskOval = 0.38   // sehr flach von oben gesehen
        let innerR = 22.0     // Event-Horizon-Radius (Punkte verschwinden hier)
        let outerR = 200.0    // Außenrand der Scheibe

        switch state {
        case .listening:
            // Spiral nach innen — Akkretion
            let phaseOffset = i / n
            let life = (now * 0.30 + phaseOffset).truncatingRemainder(dividingBy: 1)
            let radius = outerR - life * (outerR - innerR)
            let angle = life * .pi * 8 + i * 0.31 + now * 0.25
            let x = cos(angle) * radius
            let y = sin(angle) * radius * diskOval
            let fadeIn = min(1, life * 6)
            let fadeOut = min(1, (1 - life) * 5)  // verschwindet am Horizon
            let opacity = 0.6 * fadeIn * fadeOut * (level * 0.4 + 0.7)
            let size = CGFloat(2.0 - life * 0.8 + level * 1.2)
            return Particle(position: CGPoint(x: center.x + x, y: center.y + y),
                            size: size, opacity: opacity)

        case .speaking:
            // Spiral nach außen — Eruption
            let phaseOffset = i / n
            let speed = 0.32 + level * 0.5
            let life = (now * speed + phaseOffset).truncatingRemainder(dividingBy: 1)
            let radius = innerR + life * (outerR - innerR)
            // Gegenrotation zur Akkretion (visuell unterschied)
            let angle = -life * .pi * 8 + i * 0.31 + now * 0.25
            let x = cos(angle) * radius
            let y = sin(angle) * radius * diskOval
            let fadeIn = min(1, life * 6)
            let fadeOut = min(1, (1 - life) * 4)
            let opacity = 0.6 * fadeIn * fadeOut * (level * 0.4 + 0.7)
            let size = CGFloat(1.6 + life * 1.0 + level * 1.2)
            return Particle(position: CGPoint(x: center.x + x, y: center.y + y),
                            size: size, opacity: opacity)

        case .idle, .thinking:
            // Stabile konzentrische Bahnen — alle drehen sich im Uhrzeigersinn
            let n = Double(particleCount)
            let bandPos = i / n
            // Gleichmäßig zwischen innerR und outerR verteilt, mit kleinem Jitter
            let radius = innerR + 8 + bandPos * (outerR - innerR - 16)
                      + sin(i * 0.7) * 5
            // Alle Punkte rotieren in dieselbe Richtung. Innen schneller (kepler-ähnlich).
            let speedFactor = state == .thinking ? 1.0 : 0.4
            let omega = (1.0 / sqrt(radius / 50.0)) * 0.5 * speedFactor
            let angle = i * 0.6 + now * omega
            let x = cos(angle) * radius
            let y = sin(angle) * radius * diskOval
            let opacity = 0.55 * (level * 0.3 + 0.85)
            let size: CGFloat = 1.7
            return Particle(position: CGPoint(x: center.x + x, y: center.y + y),
                            size: size, opacity: opacity)
        }
    }
}

#Preview("Sphere — Listening") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0.5, state: .listening, style: .sphere, shape: .circle)
    }
}

#Preview("BlackHole — Listening (in)") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0.5, state: .listening, style: .blackHole, shape: .circle)
    }
}

#Preview("BlackHole — Thinking (rotation)") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0, state: .thinking, style: .blackHole, shape: .diamond)
    }
}

#Preview("BlackHole — Speaking (out)") {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0.6, state: .speaking, style: .blackHole, shape: .star)
    }
}
