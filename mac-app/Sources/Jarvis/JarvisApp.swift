import SwiftUI

@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Unsichtbare Scene — die App lebt vom Status-Item in der Menüleiste
        Settings { EmptyView() }
    }
}
