import Foundation
import SwiftUI

final class AppSettings: ObservableObject {
    @AppStorage("backendURL")    var backendURL: String   = "https://192.168.178.50"
    @AppStorage("authUser")      var authUser: String     = "admin"
    @AppStorage("authPass")      var authPass: String     = ""
    @AppStorage("chatId")        var chatId: String       = "ios-app"
    @AppStorage("speakReplies")  var speakReplies: Bool   = true
    @AppStorage("ttsVoice")      var ttsVoice: String     = "de-DE"
    @AppStorage("speakStreaming") var speakStreaming: Bool = false  // true = während Tokens, false = am Ende
}
