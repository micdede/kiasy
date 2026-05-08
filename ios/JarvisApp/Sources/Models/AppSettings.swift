import Foundation
import SwiftUI

final class AppSettings: ObservableObject {
    @AppStorage("backendURL")    var backendURL: String   = "https://192.168.178.50"
    @AppStorage("authUser")      var authUser: String     = "admin"
    @AppStorage("authPass")      var authPass: String     = ""
    @AppStorage("chatId")        var chatId: String       = "ios-app"
    @AppStorage("speakReplies")  var speakReplies: Bool   = true
    /// "ios" = on-device AVSpeechSynthesizer, "piper" = Server-Piper via /api/voice/synth
    @AppStorage("ttsBackend")    var ttsBackend: String   = "ios"
    /// AVSpeechSynthesisVoice.identifier (leer = beste verfügbare de-DE)
    @AppStorage("ttsVoiceID")    var ttsVoiceID: String   = ""
    /// Piper-Stimme (z.B. "de_DE-thorsten-high"); leer = Server-Default
    @AppStorage("piperVoice")    var piperVoice: String   = ""
    @AppStorage("speakStreaming") var speakStreaming: Bool = false  // true = während Tokens, false = am Ende
}
