import SwiftUI

/// Audio-reaktiver Orb im Tron-Stil. Mehrschichtig:
/// 1. Soft outer halo (radial blur)
/// 2. Orbital particle field (36 Punkte in 3 elliptischen Bahnen)
/// 3. Wireframe-Sphere (3 wabernde Polygon-Ringe mit Sin-Wave-Verformung)
/// 4. Radial beams (12 dünne Strahlen, Helligkeit pulst mit Audio)
/// 5. Plasma-Kern (Radial-Gradient + Glow)
///
/// `level` (0...1) moduliert Wave-Amplitude, Particle-Brightness, Beam-Intensity
/// und Core-Pulse. `tint` ist die primäre Farbe.
struct OrbView: View {
    let level: Double
    let tint: Color

    var body: some View {
        TimelineView(.animation(minimumInterval: 1/60, paused: false)) { ctx in
            let now = ctx.date.timeIntervalSinceReferenceDate
            let breath = sin(now * 1.3) * 0.05 + 1.0
            let levelEased = level * 0.7 + Double(sin(now * 8)) * level * 0.05  // sub-Schwingung
            let coreScale = breath * (1 + level * 0.5)

            ZStack {
                // ─── 1. Outer Halo ──────────────────────────────────
                Circle()
                    .fill(tint.opacity(0.32 + level * 0.5))
                    .frame(width: 380, height: 380)
                    .blur(radius: 75)
                    .scaleEffect(breath)

                // ─── 2. Orbital Particle Field ──────────────────────
                Canvas { gctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let particleCount = 42
                    for i in 0..<particleCount {
                        let p = Double(i) / Double(particleCount)
                        // 3 verschiedene Bahnen (3 Layer)
                        let layer = i % 3
                        let layerSpeed = [0.18, -0.12, 0.25][layer]
                        let layerR = [148.0, 168.0, 132.0][layer]
                        let layerTilt = [0.92, 0.85, 1.0][layer]  // Pseudo-3D Y-Squash

                        let angle = p * .pi * 2 + now * layerSpeed
                        let pulseR = sin(now * 0.9 + p * 6) * 18 * (level + 0.15)
                        let r = layerR + pulseR

                        let x = c.x + cos(angle) * r
                        let y = c.y + sin(angle) * r * layerTilt

                        // Pseudo-Tiefe: Punkte hinten dunkler, vorne heller
                        let depth = (sin(angle) + 1) / 2  // 0...1, hinten=0
                        let dotSize: CGFloat = 1.8 + CGFloat(depth) * 2.5 + CGFloat(level) * 2
                        let opacity = (0.25 + depth * 0.55) * (level * 0.6 + 0.5)

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

                    for ring in 0..<rings {
                        var path = Path()
                        let rp = Double(ring) / Double(rings - 1)  // 0...1
                        let depthScale = 1.0 - rp * 0.32
                        let yTilt = 0.96 - rp * 0.14

                        for s in 0...segments {
                            let theta = Double(s) / Double(segments) * .pi * 2
                            // Audio-modulierte Wellen, mehrere Frequenzen für organisches Feel
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

                        let opacity = (0.55 + level * 0.4) * (1.0 - rp * 0.35)
                        let lineWidth: CGFloat = 1.0 + CGFloat(level) * 0.8
                        gctx.stroke(path, with: .color(tint.opacity(opacity)), lineWidth: lineWidth)
                    }
                }
                .frame(width: 320, height: 320)

                // ─── 4. Radial Beams (12 Strahlen) ──────────────────
                Canvas { gctx, size in
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    let beamCount = 12
                    let inner: Double = 55
                    let outer: Double = 130 + level * 35

                    for i in 0..<beamCount {
                        let theta = Double(i) / Double(beamCount) * .pi * 2 + now * 0.25
                        let pulse = (sin(now * 3 + Double(i) * 0.6) + 1) / 2
                        let opacity = (0.06 + level * 0.55) * pulse

                        let x1 = c.x + cos(theta) * inner
                        let y1 = c.y + sin(theta) * inner * 0.93
                        let x2 = c.x + cos(theta) * outer
                        let y2 = c.y + sin(theta) * outer * 0.93

                        var path = Path()
                        path.move(to: CGPoint(x: x1, y: y1))
                        path.addLine(to: CGPoint(x: x2, y: y2))
                        gctx.stroke(path, with: .color(tint.opacity(opacity)),
                                    lineWidth: 0.7 + CGFloat(level) * 1.0)
                    }
                }
                .frame(width: 320, height: 320)

                // ─── 5. Plasma Core ────────────────────────────────
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
                    .shadow(color: tint.opacity(0.85), radius: 22 + 20 * level)
                    .shadow(color: tint.opacity(0.55), radius: 50 + 35 * level)

                // Specular highlight
                Circle()
                    .fill(Color.white.opacity(0.55))
                    .frame(width: 22, height: 22)
                    .blur(radius: 8)
                    .offset(x: -16, y: -18)
                    .scaleEffect(coreScale)
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
