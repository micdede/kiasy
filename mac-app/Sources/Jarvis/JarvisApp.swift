import SwiftUI

@main
struct JarvisApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            ChatView()
                .environmentObject(state)
                .frame(width: 420, height: 540)
        } label: {
            Image(systemName: "brain.head.profile")
        }
        .menuBarExtraStyle(.window)
    }
}
