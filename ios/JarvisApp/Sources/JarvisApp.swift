import SwiftUI
import UserNotifications

// MARK: - AppDelegate

class AppDelegate: NSObject, UIApplicationDelegate {
    var api: JarvisAPI?
    var settings: AppSettings?

    // Token wird gespeichert falls er vor onAppear ankommt
    private var pendingToken: String?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[APNs] device token: \(token)")
        pendingToken = token
        uploadTokenIfReady()
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[APNs] registration failed: \(error.localizedDescription)")
    }

    /// Wird von JarvisApp.onAppear gerufen sobald api+settings gesetzt sind.
    func onSettingsReady() {
        uploadTokenIfReady()
    }

    private func uploadTokenIfReady() {
        guard let token = pendingToken,
              let api, let settings,
              !settings.baseURL.isEmpty else { return }
        pendingToken = nil
        Task {
            await api.registerAPNsToken(
                token,
                device: UIDevice.current.name,
                baseURL: settings.baseURL,
                user: settings.authUser,
                pass: settings.authPass
            )
        }
    }
}

// MARK: - App

@main
struct JarvisApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var settings = AppSettings()
    private let api = JarvisAPI()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .preferredColorScheme(.dark)
                .onAppear {
                    appDelegate.api      = api
                    appDelegate.settings = settings
                    appDelegate.onSettingsReady()
                }
        }
    }
}
