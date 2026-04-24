import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var username: String {
        didSet { UserDefaults.standard.set(username, forKey: "username") }
    }
    @Published var password: String {
        didSet { try? Keychain.set(password, account: "monitor") }
    }

    @Published var messages: [ChatMessage] = []
    @Published var isSending = false
    @Published var lastError: String? = nil
    @Published var showingSettings = false

    init() {
        let url = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        let user = UserDefaults.standard.string(forKey: "username") ?? ""
        let pass = (try? Keychain.get(account: "monitor")) ?? ""
        self.serverURL = url
        self.username = user
        self.password = pass
        if url.isEmpty || user.isEmpty || pass.isEmpty {
            self.showingSettings = true
        }
    }

    var isConfigured: Bool {
        !serverURL.isEmpty && !username.isEmpty && !password.isEmpty
    }

    private func client() -> Networking {
        Networking(serverURL: serverURL, username: username, password: password)
    }

    func loadHistory() async {
        guard isConfigured else { return }
        do {
            messages = try await client().fetchHistory()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func send(_ text: String) async {
        guard isConfigured, !text.isEmpty else { return }
        messages.append(ChatMessage(role: "user", text: text))
        isSending = true
        defer { isSending = false }
        do {
            let reply = try await client().send(message: text)
            if !reply.isEmpty {
                messages.append(ChatMessage(role: "assistant", text: reply))
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            messages.append(ChatMessage(role: "assistant", text: "⚠️ \(error.localizedDescription)"))
        }
    }

    func clear() async {
        guard isConfigured else { return }
        do {
            try await client().clearHistory()
            messages = []
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}

struct ChatMessage: Identifiable, Hashable {
    let id = UUID()
    let role: String
    let text: String
}
