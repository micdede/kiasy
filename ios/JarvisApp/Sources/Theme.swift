import SwiftUI

/// Tron-inspirierte Farbpalette passend zum AppIcon.
/// Tiefes Navy als Background, Cyan als Akzent, kühles Weiß als Text.
enum Theme {
    // Backgrounds
    static let bgDeep      = Color(red: 0.020, green: 0.040, blue: 0.080)   // #050B14 — fast schwarz
    static let bgCard      = Color(red: 0.040, green: 0.075, blue: 0.130)   // #0A1321
    static let bgElevated  = Color(red: 0.060, green: 0.105, blue: 0.180)   // #0F1B2E
    static let bgHairline  = Color(red: 0.090, green: 0.150, blue: 0.230)   // #17263B

    // Accents
    static let accent      = Color(red: 0.305, green: 0.831, blue: 1.000)   // #4ED4FF — Tron-Cyan
    static let accentSoft  = Color(red: 0.305, green: 0.831, blue: 1.000).opacity(0.18)
    static let accentGlow  = Color(red: 0.305, green: 0.831, blue: 1.000).opacity(0.45)

    // Text
    static let text        = Color(red: 0.880, green: 0.945, blue: 1.000)   // #E0F1FF
    static let textDim     = Color(red: 0.420, green: 0.560, blue: 0.700)   // #6B8FB3

    // Status
    static let ok          = Color(red: 0.430, green: 0.945, blue: 0.745)   // #6EF1BE
    static let warn        = Color(red: 1.000, green: 0.745, blue: 0.420)   // #FFBE6B
    static let err         = Color(red: 1.000, green: 0.420, blue: 0.480)   // #FF6B7A

    // User-Bubble: leichter Cyan-Tönung
    static let bubbleUser  = Color(red: 0.305, green: 0.831, blue: 1.000).opacity(0.22)
    static let bubbleAssist = Color(red: 0.060, green: 0.105, blue: 0.180)  // = bgElevated
}

// SwiftUI hat keinen nativen Placeholder für TextField im dunklen Theme,
// daher der klassische Overlay-Trick.
extension View {
    @ViewBuilder
    func placeholder<P: View>(when shouldShow: Bool, @ViewBuilder _ placeholder: () -> P) -> some View {
        ZStack(alignment: .leading) {
            if shouldShow { placeholder() }
            self
        }
    }
}
