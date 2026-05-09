import SwiftUI

/// State-Maschine für den Orb. Bestimmt Farbe + Particle-Bewegungs-Pattern.
enum OrbState {
    case idle        // wartet auf Trigger — gedämpftes Cyan, ruhiges Atmen der Sphere
    case listening   // hört zu — Cyan, Sphere wabert audio-reaktiv
    case thinking    // verarbeitet — Amber/Gold, Spiral-Vortex zum Zentrum
    case speaking    // spricht — Magenta-Violett, Schallwellen vom Zentrum nach außen

    var primaryColor: Color {
        switch self {
        case .idle:      return Color(hue: 0.53, saturation: 0.55, brightness: 0.85)
        case .listening: return Theme.accent
        case .thinking:  return Color(hue: 0.10, saturation: 0.88, brightness: 1.00)
        case .speaking:  return Color(hue: 0.78, saturation: 0.78, brightness: 1.00)
        }
    }
}

/// Audio-reaktiver Particle-Orb. Komplett aus 400 Punkten gerendert,
/// jeder State ein eigenes prozedurales Bewegungs-Pattern:
///
/// - **Idle / Listening**: Punkte sitzen auf einer Pseudo-3D-Sphere
///   (Fibonacci-Verteilung). Sphere rotiert sanft, atmet, audio moduliert
///   Wabern. Vorne hell, hinten dunkel (Pseudo-3D-Tiefe).
/// - **Thinking**: Spiral-Vortex — Punkte spiralen kontinuierlich vom Rand
///   ins Zentrum, am Zentrum re-emit am Rand. Wirkt wie ein Mahlstrom.
/// - **Speaking**: Schallwellen — Punkte fliegen in mehreren Wellen vom
///   Zentrum radial nach außen, am Rand fadet, neue Welle vom Zentrum.
///   Audio-Level moduliert Wellen-Geschwindigkeit + Reichweite.
struct OrbView: View {
    let level: Double
    let state: OrbState

    /// 400 Particles ergeben einen dichten Schwarm ohne Performance-Probleme
    /// auf modernen iPhones (~24k Canvas-Fills/sec bei 60fps).
    private let particleCount = 400

    private var tint: Color { state.primaryColor }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1/60, paused: false)) { ctx in
            let now = ctx.date.timeIntervalSinceReferenceDate
            let breath = sin(now * 1.3) * 0.04 + 1.0

            ZStack {
                // Subtiler Halo damit der Orb auf dunklem Background "sitzt"
                Circle()
                    .fill(tint.opacity(0.28 + level * 0.4))
                    .frame(width: 360, height: 360)
                    .blur(radius: 75)
                    .scaleEffect(breath)

                // Das Particle-Field — alles passiert hier
                Canvas { gctx, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    for i in 0..<particleCount {
                        let p = particle(index: i, now: now, center: center)
                        let dot = CGRect(x: p.position.x - p.size / 2,
                                         y: p.position.y - p.size / 2,
                                         width: p.size, height: p.size)
                        gctx.fill(Path(ellipseIn: dot),
                                  with: .color(tint.opacity(p.opacity)))
                    }
                }
                .frame(width: 500, height: 500)
                .blur(radius: 0.5)
            }
            .animation(.easeInOut(duration: 0.6), value: state)
        }
    }

    // MARK: - Particle-Berechnung pro State

    private struct Particle {
        let position: CGPoint
        let size: CGFloat
        let opacity: Double
    }

    private func particle(index: Int, now: Double, center: CGPoint) -> Particle {
        switch state {
        case .idle, .listening:
            return sphereParticle(index: index, now: now, center: center)
        case .thinking:
            return vortexParticle(index: index, now: now, center: center)
        case .speaking:
            return shockwaveParticle(index: index, now: now, center: center)
        }
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

    /// Spiral-Vortex — jeder Punkt hat einen eigenen "Lebenslauf":
    /// startet am Rand, spiraliert ins Zentrum, dann re-emit am Rand.
    /// Kontinuierlicher Strom durch Phasen-Versatz pro Punkt.
    private func vortexParticle(index: Int, now: Double, center: CGPoint) -> Particle {
        let i = Double(index)
        let n = Double(particleCount)

        // Lebens-Phase 0...1, Phasen-Versatz pro Punkt
        let phaseOffset = i / n
        let life = (now * 0.32 + phaseOffset).truncatingRemainder(dividingBy: 1.0)

        // Radius schrumpft von außen (180) zum Zentrum (8) während life 0→1
        let radius = 180.0 * (1.0 - life) + 8.0
        // Spiral: 4 Umdrehungen pro Lebenszyklus + Konstanten-Offset pro Punkt
        let angle = life * .pi * 8 + i * 0.45
        let x = cos(angle) * radius
        let y = sin(angle) * radius * 0.92  // leicht oval

        // Fade in am Rand, Fade out im Zentrum
        let fadeIn = min(1, life * 8)        // erste 12% einfaden
        let fadeOut = min(1, (1 - life) * 6) // letzte 17% ausfaden
        let opacity = 0.55 * fadeIn * fadeOut

        // Punkte werden kleiner Richtung Zentrum (perspektivisch zoomen)
        let size = CGFloat(2.3 - life * 1.2)

        return Particle(position: CGPoint(x: center.x + x, y: center.y + y),
                        size: size, opacity: opacity)
    }

    /// Schallwellen — Punkte fliegen in mehreren Wellen vom Zentrum nach außen.
    /// Audio-Level moduliert Wellen-Geschwindigkeit + max-Reichweite.
    private func shockwaveParticle(index: Int, now: Double, center: CGPoint) -> Particle {
        let i = Double(index)
        let n = Double(particleCount)

        // 5 parallele Wellen — jeder Punkt gehört zu einer
        let waveCount = 5.0
        let waveIndex = floor(i.truncatingRemainder(dividingBy: waveCount))
        let waveOffset = waveIndex / waveCount

        // Lebens-Phase mit audio-modulierter Geschwindigkeit
        let speed = 0.55 + level * 0.85
        let life = (now * speed + waveOffset).truncatingRemainder(dividingBy: 1.0)

        // Radius wächst von Zentrum (15) nach außen (max 230, audio-boosted)
        let maxR = 180.0 + level * 80.0
        let radius = 15.0 + life * maxR
        // Winkel: jeder Punkt seinen eigenen, bleibt während Welle gleich
        let angle = i * 0.157  // golden-ratio-ish spread
        let x = cos(angle) * radius
        let y = sin(angle) * radius * 0.92

        // Fade out am Rand
        let fadeIn = min(1, life * 12)        // schnell einfaden
        let fadeOut = max(0, 1 - life * 1.05) // dann linear ausfaden
        let opacity = (0.5 + level * 0.4) * fadeIn * fadeOut

        let size = CGFloat(2.0 + life * 1.5 + level * 1.5)

        return Particle(position: CGPoint(x: center.x + x, y: center.y + y),
                        size: size, opacity: opacity)
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
