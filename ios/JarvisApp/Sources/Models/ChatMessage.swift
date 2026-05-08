import Foundation

struct ChatMessage: Identifiable, Equatable {
    enum Role: String { case user, assistant, tool, error, system }

    let id = UUID()
    let role: Role
    var text: String
    let timestamp = Date()
    var isStreaming: Bool = false
}
