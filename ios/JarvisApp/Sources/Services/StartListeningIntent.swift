import AppIntents
import Foundation

/// System-Intent „Mit JARVIS sprechen" — der Schlüssel für alle System-Trigger.
///
/// Sobald die App einmal lief und das Intent registriert ist, kann der User es
/// überall im System zuweisen, wo iOS Shortcuts nimmt:
/// - Action-Button (iPhone 15 Pro / 16) → Settings → Aktion → Shortcut
/// - „Auf Rückseite tippen" → Settings → Bedienungshilfen → Tippen → Auf Rückseite tippen
/// - Lock-Screen-Widget (iOS 16+)
/// - Control-Center-Custom-Control (iOS 18+)
/// - Siri („Hey Siri, sprich mit JARVIS")
/// - Apple Watch Shortcut
/// - Shortcuts-App für eigene Automationen
///
/// Mechanik: openAppWhenRun=true bringt die App in den Vordergrund (auch aus
/// Lock-Screen), perform() postet eine Notification, ContentView observiert die
/// und startet die Aufnahme.
struct StartListeningIntent: AppIntent {
    static var title: LocalizedStringResource = "Mit JARVIS sprechen"
    static var description = IntentDescription("Startet eine neue Sprachaufnahme für JARVIS.")
    /// Holt die App in den Vordergrund (sonst läuft das Intent im Background-Helper).
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            NotificationCenter.default.post(name: .startListeningTrigger, object: nil)
        }
        return .result()
    }
}

/// Macht das Intent in Spotlight + Siri auffindbar mit gesprochenen Phrasen.
/// Phrases müssen `\(.applicationName)` enthalten — bei uns ergibt das „JARVIS"
/// (CFBundleDisplayName). Beispiele: „Sprich mit JARVIS", „JARVIS hör zu".
struct JarvisAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartListeningIntent(),
            phrases: [
                "Sprich mit \(.applicationName)",
                "Mit \(.applicationName) reden",
                "\(.applicationName) hör zu"
            ],
            shortTitle: "Sprechen",
            systemImageName: "mic.fill"
        )
    }
}

extension Notification.Name {
    /// Wird vom AppIntent gepostet wenn der User einen System-Trigger ausgelöst hat
    /// (Action-Button, Siri, Back-Tap, Widget, Watch, …).
    static let startListeningTrigger = Notification.Name("jarvis.startListeningTrigger")
}
