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

    private func makeRequest(_ path: String,
                             query: [URLQueryItem] = [],
                             method: String = "GET",
                             contentType: String = "application/json",
                             body: Data? = nil) throws -> URLRequest {
        guard let base = baseURL else { throw NetError.invalidURL }
        let withPath = base.appendingPathComponent(path)
        var components = URLComponents(url: withPath, resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw NetError.invalidURL }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(authHeader, forHTTPHeaderField: "Authorization")
        if let body = body {
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
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

    // MARK: - Endpoints

    func send(message: String) async throws -> (text: String, images: [ChatImage]) {
        let body = try JSONSerialization.data(withJSONObject: ["message": message])
        let req = try makeRequest("api/chat/send", method: "POST", body: body)
        let data = try await perform(req)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (
            text: (json?["text"] as? String) ?? "",
            images: parseImages(json?["images"])
        )
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

    func sendVoice(audioData: Data) async throws -> (transcript: String, text: String, images: [ChatImage]) {
        let req = try makeRequest("api/chat/voice",
                                  method: "POST",
                                  contentType: "audio/mp4",
                                  body: audioData)
        let data = try await perform(req)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (
            transcript: (json?["transcript"] as? String) ?? "",
            text: (json?["text"] as? String) ?? "",
            images: parseImages(json?["images"])
        )
    }

    func fetchImage(urlOrPath: String) async throws -> Data {
        if urlOrPath.hasPrefix("http://") || urlOrPath.hasPrefix("https://") {
            // Externe URL — direkter Download (ohne Auth)
            guard let url = URL(string: urlOrPath) else { throw NetError.invalidURL }
            let req = URLRequest(url: url)
            return try await perform(req)
        }
        let cleanPath = urlOrPath.hasPrefix("/") ? String(urlOrPath.dropFirst()) : urlOrPath
        let req = try makeRequest(cleanPath)
        return try await perform(req)
    }

    private func parseImages(_ raw: Any?) -> [ChatImage] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { dict in
            guard let url = dict["url"] as? String, !url.isEmpty else { return nil }
            return ChatImage(url: url, caption: (dict["caption"] as? String) ?? "")
        }
    }

    /// Streaming-Variante von sendVoice — yieldet SSE-Events live.
    /// Mac kann pro Satz parallel TTS anfragen.
    func sendVoiceStream(audioData: Data) -> AsyncThrowingStream<StreamEvent, Error> {
        sseStream(path: "api/chat/voice/stream", contentType: "audio/mp4", body: audioData)
    }

    /// Streaming für reine Text-Eingabe — z.B. wenn STT lokal auf dem Mac läuft (SFSpeechRecognizer).
    func sendMessageStream(message: String) -> AsyncThrowingStream<StreamEvent, Error> {
        let body = (try? JSONSerialization.data(withJSONObject: ["message": message])) ?? Data()
        return sseStream(path: "api/chat/send/stream", contentType: "application/json", body: body)
    }

    private func sseStream(path: String, contentType: String, body: Data) -> AsyncThrowingStream<StreamEvent, Error> {
        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let req = try makeRequest(path, method: "POST", contentType: contentType, body: body)
                    let session = makeSession()
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse else {
                        continuation.finish(throwing: NetError.http(0, "Keine HTTP-Antwort")); return
                    }
                    if !(200..<300).contains(http.statusCode) {
                        var bodyStr = ""
                        for try await line in bytes.lines { bodyStr += line; if bodyStr.count > 200 { break } }
                        continuation.finish(throwing: NetError.http(http.statusCode, bodyStr)); return
                    }

                    var currentEvent = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("event: ") {
                            currentEvent = String(line.dropFirst("event: ".count))
                        } else if line.hasPrefix("data: ") {
                            let payload = String(line.dropFirst("data: ".count))
                            if let event = StreamEvent.parse(name: currentEvent, payload: payload) {
                                continuation.yield(event)
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    func tts(text: String, voice: String = "", speed: Double = 1.0) async throws -> Data {
        var payload: [String: Any] = ["text": text]
        if !voice.isEmpty { payload["voice"] = voice }
        if abs(speed - 1.0) > 0.01 { payload["speed"] = speed }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let req = try makeRequest("api/chat/tts",
                                  query: [URLQueryItem(name: "format", value: "mp3")],
                                  method: "POST",
                                  body: body)
        return try await perform(req)
    }

    /// Lädt das Piper-Modell vorab (Cold-Start vermeiden) — fire-and-forget OK.
    func warmupTTS(voice: String = "") async {
        var query: [URLQueryItem] = []
        if !voice.isEmpty { query.append(URLQueryItem(name: "voice", value: voice)) }
        guard let req = try? makeRequest("api/tts/warmup", query: query, method: "POST") else { return }
        _ = try? await perform(req)
    }

    /// Lädt verfügbare Piper-Stimmen vom Server. Liefert leere Liste wenn Piper nicht aktiv.
    func listPiperVoices() async throws -> [PiperVoice] {
        let req = try makeRequest("api/tts/voices")
        let data = try await perform(req)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let arr = (json?["voices"] as? [[String: Any]]) ?? []
        return arr.compactMap { dict in
            guard let name = dict["name"] as? String, !name.isEmpty else { return nil }
            return PiperVoice(name: name, description: (dict["description"] as? String) ?? name)
        }
    }
}

enum StreamEvent {
    case transcript(String)
    case delta(String)
    case sentence(text: String, seq: Int)
    case toolUse(String)
    case discard
    case done(text: String, images: [ChatImage])
    case streamError(String)

    static func parse(name: String, payload: String) -> StreamEvent? {
        guard let data = payload.data(using: .utf8) else { return nil }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        switch name {
        case "transcript": return .transcript((json["text"] as? String) ?? "")
        case "delta":      return .delta((json["text"] as? String) ?? "")
        case "sentence":
            return .sentence(text: (json["text"] as? String) ?? "",
                             seq: (json["seq"] as? Int) ?? 0)
        case "tool_use":   return .toolUse((json["name"] as? String) ?? "")
        case "discard":    return .discard
        case "done":
            let text = (json["text"] as? String) ?? ""
            let imgs = (json["images"] as? [[String: Any]] ?? []).compactMap { dict -> ChatImage? in
                guard let url = dict["url"] as? String, !url.isEmpty else { return nil }
                return ChatImage(url: url, caption: (dict["caption"] as? String) ?? "")
            }
            return .done(text: text, images: imgs)
        case "error":      return .streamError((json["error"] as? String) ?? "Unbekannter Fehler")
        default: return nil
        }
    }
}

final class TrustingDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler)
    }

    // bytes(for:) eskaliert Server-Trust-Challenges auf Task-Ebene — separat behandeln.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handle(challenge, completionHandler)
    }

    private func handle(
        _ challenge: URLAuthenticationChallenge,
        _ completionHandler: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
