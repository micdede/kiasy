import Foundation

enum SSEEvent {
    case delta(String)
    case toolUse(name: String, input: [String: Any])
    case toolResult(Any)
    case done
    case error(String)
}

actor JarvisAPI {
    private let session: URLSession

    init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 600
        cfg.timeoutIntervalForResource = 600
        // Caddy-Root-Cert ist als Trusted Profile auf dem iPhone installiert →
        // Standard-URLSession reicht, keine Cert-Override nötig.
        self.session = URLSession(configuration: cfg)
    }

    func sendStream(
        baseURL: String,
        user: String,
        pass: String,
        chatId: String,
        message: String
    ) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { cont in
            Task {
                do {
                    guard let url = URL(string: "\(baseURL)/api/chat/send/stream") else {
                        cont.finish(throwing: URLError(.badURL)); return
                    }
                    var req = URLRequest(url: url)
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if !user.isEmpty {
                        let token = "\(user):\(pass)".data(using: .utf8)!.base64EncodedString()
                        req.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
                    }
                    req.httpBody = try JSONSerialization.data(withJSONObject: [
                        "chatId": chatId,
                        "message": message
                    ])

                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                        cont.finish(throwing: NSError(domain: "JarvisAPI", code: http.statusCode,
                            userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"]))
                        return
                    }

                    var currentEvent: String? = nil
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            if let ev = currentEvent {
                                let payload = dataLines.joined(separator: "\n")
                                if let parsed = parseEvent(name: ev, data: payload) {
                                    cont.yield(parsed)
                                }
                            }
                            currentEvent = nil
                            dataLines = []
                            continue
                        }
                        if line.hasPrefix("event: ") {
                            currentEvent = String(line.dropFirst(7))
                        } else if line.hasPrefix("data: ") {
                            dataLines.append(String(line.dropFirst(6)))
                        }
                    }
                    cont.yield(.done)
                    cont.finish()
                } catch {
                    cont.finish(throwing: error)
                }
            }
        }
    }

    private func parseEvent(name: String, data: String) -> SSEEvent? {
        guard let jsonData = data.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            return nil
        }
        switch name {
        case "delta":
            if let text = obj["text"] as? String { return .delta(text) }
        case "tool_use":
            let n = obj["name"] as? String ?? "?"
            let input = obj["input"] as? [String: Any] ?? [:]
            return .toolUse(name: n, input: input)
        case "tool_result":
            return .toolResult(obj["result"] ?? "")
        case "done":
            return .done
        case "error":
            return .error(obj["error"] as? String ?? "unbekannter Fehler")
        default:
            break
        }
        return nil
    }
}

// SelfSignedDelegate entfernt — Caddy-Root-Cert ist jetzt als Trusted Profile
// auf dem Gerät installiert, daher reicht die Standard-Cert-Validierung.
