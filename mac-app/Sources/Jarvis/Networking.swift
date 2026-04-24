import Foundation

struct Networking {
    let serverURL: String
    let username: String
    let password: String

    enum NetError: LocalizedError {
        case invalidURL
        case http(Int, String)
        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Ungültige Server-URL"
            case .http(let code, let body):
                return "HTTP \(code): \(body.prefix(200))"
            }
        }
    }

    private var baseURL: URL? {
        let trimmed = serverURL.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: trimmed)
    }

    private var authHeader: String {
        let raw = "\(username):\(password)"
        return "Basic " + Data(raw.utf8).base64EncodedString()
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90
        return URLSession(configuration: config, delegate: TrustingDelegate(), delegateQueue: nil)
    }

    private func makeRequest(_ path: String, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard let url = baseURL?.appendingPathComponent(path) else { throw NetError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(authHeader, forHTTPHeaderField: "Authorization")
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    private func perform(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await makeSession().data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw NetError.http(0, "Keine HTTP-Antwort")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw NetError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    func send(message: String) async throws -> String {
        let body = try JSONSerialization.data(withJSONObject: ["message": message])
        let req = try makeRequest("api/chat/send", method: "POST", body: body)
        let data = try await perform(req)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (json?["text"] as? String) ?? ""
    }

    func fetchHistory() async throws -> [ChatMessage] {
        let req = try makeRequest("api/chat/history")
        let data = try await perform(req)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let items = (json?["messages"] as? [[String: Any]]) ?? []
        return items.compactMap {
            guard let role = $0["role"] as? String,
                  let text = $0["text"] as? String,
                  !text.isEmpty else { return nil }
            return ChatMessage(role: role, text: text)
        }
    }

    func clearHistory() async throws {
        let req = try makeRequest("api/chat/clear", method: "POST")
        _ = try await perform(req)
    }
}

final class TrustingDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
