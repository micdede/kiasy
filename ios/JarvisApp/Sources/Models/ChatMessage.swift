import Foundation

struct ChatMessage: Identifiable, Equatable {
    enum Role: String { case user, assistant, tool, error, system }

    let id: UUID
    let role: Role
    var text: String
    let timestamp: Date
    var isStreaming: Bool = false
    /// optional vollständige URL (mit Backend-Prefix) — wird gerendert als Inline-Image
    var imageURL: String? = nil

    init(role: Role, text: String, isStreaming: Bool = false, imageURL: String? = nil) {
        self.id = UUID()
        self.role = role
        self.text = text
        self.timestamp = Date()
        self.isStreaming = isStreaming
        self.imageURL = imageURL
    }

    /// Mappt eine Server-History-Zeile (`{role, content, msg_type, meta, created_at}`)
    /// auf eine ChatMessage. Liefert nil für Rollen, die im UI nichts zu suchen haben
    /// (tool-Aufrufe, system-Prompt etc.).
    init?(serverDict d: [String: Any]) {
        guard
            let roleRaw = d["role"] as? String,
            let role = Role(rawValue: roleRaw),
            let content = d["content"] as? String
        else { return nil }
        // tool-Antworten und system-Messages nicht im Verlauf zeigen
        if role == .tool || role == .system { return nil }
        // leere Assistant-Antworten (z.B. wenn nur Tool-Calls passierten) skippen
        if role == .assistant, content.isEmpty { return nil }

        self.id = UUID()
        self.role = role
        self.text = content
        self.isStreaming = false
        self.imageURL = nil
        // created_at parsen, fallback now
        if let s = d["created_at"] as? String, let dt = Self.iso8601.date(from: s) {
            self.timestamp = dt
        } else if let s = d["created_at"] as? String, let dt = Self.sqliteFmt.date(from: s) {
            self.timestamp = dt
        } else {
            self.timestamp = Date()
        }
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let sqliteFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
