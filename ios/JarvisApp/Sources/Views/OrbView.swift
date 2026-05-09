import SwiftUI

/// State-Maschine für den Orb. Steuert nur noch die Particle-Farbe;
/// das Bewegungs-Pattern (Sphere) ist jetzt für alle States gleich.
enum OrbState {
    case idle        // wartet auf Trigger — gedämpftes Weiß
    case listening   // hört zu — weiß
    case thinking    // verarbeitet — grau
    case speaking    // spricht — Cyan

    /// Farbe der Particles. Halo + Hintergrund bleiben immer Cyan (siehe OrbView).
    var primaryColor: Color {
        switch self {
        case .idle:      return Color.white.opacity(0.5)
        case .listening: return Color.white
        case .thinking:  return Color(white: 0.55)        // mittelgrau
        case .speaking:  return Theme.accent              // Tron-Cyan
        }
    }
}

/// Audio-reaktiver Particle-Orb. 400 Punkte auf einer Pseudo-3D-Sphere
/// (Fibonacci-Verteilung). Sphere rotiert sanft, atmet, audio moduliert
/// Wabern. Vorne hell, hinten dunkel (Pseudo-3D-Tiefe).
///
/// Alle States nutzen dasselbe Pattern — der Unterschied ist nur die
/// Particle-Farbe (`state.primaryColor`). Halo bleibt immer Cyan damit
/// der Orb visuell auf dem dunklen Background sitzt.
struct OrbView: View {
    let level: Double
    let state: OrbState

    /// 400 Particles ergeben einen dichten Schwarm ohne Performance-Probleme
    /// auf modernen iPhones (~24k Canvas-Fills/sec bei 60fps).
    private let particleCount = 400

    private var particleColor: Color { state.primaryColor }
    /// Halo immer Cyan (User-Wunsch: Hintergrund konsistent)
    private var haloColor: Color { Theme.accent }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1/60, paused: false)) { ctx in
            let now = ctx.date.timeIntervalSinceReferenceDate
            let breath = sin(now * 1.3) * 0.04 + 1.0

            ZStack {
                // Subtiler Cyan-Halo damit der Orb auf dunklem BG "sitzt"
                Circle()
                    .fill(haloColor.opacity(0.28 + level * 0.4))
                    .frame(width: 360, height: 360)
                    .blur(radius: 75)
                    .scaleEffect(breath)

                // Das Particle-Field
                Canvas { gctx, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    for i in 0..<particleCount {
                        let p = sphereParticle(index: i, now: now, center: center)
                        let dot = CGRect(x: p.position.x - p.size / 2,
                                         y: p.position.y - p.size / 2,
                                         width: p.size, height: p.size)
                        gctx.fill(Path(ellipseIn: dot),
                                  with: .color(particleColor.opacity(p.opacity)))
                    }
                }
                .frame(width: 500, height: 500)
                .blur(radius: 0.5)
            }
            .animation(.easeInOut(duration: 0.6), value: state)
        }
    }

    // MARK: - Particle-Berechnung

    private struct Particle {
        let position: CGPoint
        let size: CGFloat
        let opacity: Double
    }

    /// Fibonacci-Sphere — gleichmäßige Verteilung von N Punkten auf einer Kugeloberfläche.
    /// Wird sanft rotiert (Y-Achse) und atmet; Audio-Level moduliert Wabern.
    private func sphereParticle(index: Int, now: Double, center: CGPoint) -> Particle {
        let n = Double(particleCount)
        let i = Double(index)
        let goldenAngle = .pi * (3.0 - sqrt(5.0))
        // y in [-1, 1], gleichmäßig verteilt
        let y = 1.0 - (i / (n - 1)) * 2.0
        let radiusAtY = sqrt(1.0 - y * y)
        let theta = goldenAngle * i + now * 0.18  // Y-Rotation über Zeit
        let xUnit = cos(theta) * radiusAtY
        let zUnit = sin(theta) * radiusAtY

        // Audio-Wabern: jeder Punkt wackelt mit eigener Phase
        let wave = sin(now * 2.5 + i * 0.4) * 0.04 * (level + 0.15)
        let breath = sin(now * 1.2) * 0.03 + 1.0
        let r: Double = 105.0 * (breath + wave)

        let px = center.x + xUnit * r
        let py = center.y + y * r * 0.95  // leicht gestaucht für ovaleren Look

        // z bestimmt Tiefe: vorne hell, hinten dunkel
        let depth = (zUnit + 1) / 2  // 0 (hinten) ... 1 (vorne)
        let opacity = (0.15 + depth * 0.7) * (level * 0.5 + 0.55)
        let size = CGFloat(1.4 + depth * 2.0 + level * 1.5)

        return Particle(position: CGPoint(x: px, y: py), size: size, opacity: opacity)
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
