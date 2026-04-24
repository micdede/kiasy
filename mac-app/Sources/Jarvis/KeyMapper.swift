import Foundation
import AppKit

enum KeyMapper {
    /// Liefert eine lesbare Bezeichnung für einen virtuellen Tastencode.
    static func name(for keyCode: Int) -> String {
        if let n = special[keyCode] { return n }
        if let l = letters[keyCode] { return l.uppercased() }
        return "Key \(keyCode)"
    }

    /// Vollständige Anzeige inkl. Modifier-Symbolen.
    static func display(keyCode: Int, modifiers: NSEvent.ModifierFlags) -> String {
        var parts: [String] = []
        if modifiers.contains(.control) { parts.append("⌃") }
        if modifiers.contains(.option)  { parts.append("⌥") }
        if modifiers.contains(.shift)   { parts.append("⇧") }
        if modifiers.contains(.command) { parts.append("⌘") }
        parts.append(name(for: keyCode))
        return parts.joined()
    }

    static let relevantModifierMask: NSEvent.ModifierFlags = [.command, .option, .control, .shift]

    private static let special: [Int: String] = [
        49: "Space", 53: "Esc", 36: "Return", 48: "Tab", 51: "⌫", 117: "⌦",
        123: "←", 124: "→", 125: "↓", 126: "↑",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5",
        97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
        103: "F11", 111: "F12",
        105: "F13", 107: "F14", 113: "F15", 106: "F16",
        64: "F17", 79: "F18", 80: "F19",
    ]

    private static let letters: [Int: String] = [
        0: "a", 11: "b", 8: "c", 2: "d", 14: "e", 3: "f", 5: "g",
        4: "h", 34: "i", 38: "j", 40: "k", 37: "l", 46: "m", 45: "n",
        31: "o", 35: "p", 12: "q", 15: "r", 1: "s", 17: "t", 32: "u",
        9: "v", 13: "w", 7: "x", 16: "y", 6: "z",
        29: "0", 18: "1", 19: "2", 20: "3", 21: "4",
        23: "5", 22: "6", 26: "7", 28: "8", 25: "9",
    ]
}
