import SwiftUI

/// Animierter Orb der auf Audio-Level reagiert. Tron-Style mit Cyan-Glow,
/// expandierenden konzentrischen Ringen und einem zentralen pulsierenden Kern.
///
/// `level` (0...1) steuert wie stark der Orb pulsiert + wie schnell die Ringe
/// expandieren. `tint` ist die primäre Farbe (Cyan beim Listening, leicht
/// violett verschoben beim Speaking).
struct OrbView: View {
    let level: Double
    let tint: Color

    var body: some View {
        TimelineView(.animation(minimumInterval: 1/60, paused: false)) { ctx in
            let now = ctx.date.timeIntervalSinceReferenceDate
            let breath = sin(now * 1.4) * 0.04 + 1.0   // langsames Atmen (idle)
            let levelBoost = 1 + level * 0.55          // bis 55% Größenwachstum bei lautem Audio
            let scale = breath * levelBoost

            ZStack {
                // ─── Outer Glow Halo (radial blur) ──────────────────
                Circle()
                    .fill(tint.opacity(0.25 + level * 0.45))
                    .frame(width: 360, height: 360)
                    .blur(radius: 70)
                    .scaleEffect(scale)

                // ─── Expandierende Ringe ────────────────────────────
                Canvas { gctx, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    let baseR: Double = 80
                    let spread: Double = 200
                    let speed: Double = 0.45 + level * 0.6
                    let ringCount = 7

                    for i in 0..<ringCount {
                        let phase = ((now * speed) + Double(i) / Double(ringCount))
                            .truncatingRemainder(dividingBy: 1.0)
                        let r = baseR + phase * spread * (level + 0.18)
                        let opacity = (1 - phase) * (level * 0.85 + 0.18)
                        let lineWidth: CGFloat = 1.0 + CGFloat(level) * 1.4
                        let rect = CGRect(x: center.x - r, y: center.y - r,
                                          width: r * 2, height: r * 2)
                        let path = Path(ellipseIn: rect)
                        gctx.stroke(path, with: .color(tint.opacity(opacity)), lineWidth: lineWidth)
                    }
                }
                .frame(width: 440, height: 440)

                // ─── Inner Orb (Radial-Gradient, leichter 3D-Look) ─
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color.white.opacity(0.95),
                                tint.opacity(0.85),
                                tint.opacity(0.4)
                            ],
                            center: UnitPoint(x: 0.38, y: 0.32),
                            startRadius: 4,
                            endRadius: 95
                        )
                    )
                    .frame(width: 130, height: 130)
                    .scaleEffect(scale)
                    .shadow(color: tint.opacity(0.85), radius: 30 + 25 * level)
                    .shadow(color: tint.opacity(0.5), radius: 60 + 40 * level)

                // ─── Highlight (specular) ───────────────────────────
                Circle()
                    .fill(Color.white.opacity(0.55))
                    .frame(width: 28, height: 28)
                    .blur(radius: 10)
                    .offset(x: -20, y: -22)
                    .scaleEffect(scale)
            }
            .animation(.easeOut(duration: 0.08), value: level)
        }
    }
}

#Preview {
    ZStack {
        Theme.bgDeep.ignoresSafeArea()
        OrbView(level: 0.5, tint: Theme.accent)
    }
}
