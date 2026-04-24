import SwiftUI
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    let state = AppState()
    private var globalMonitor: Any?
    private var localMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        // Status-Item in der Menüleiste
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "brain.head.profile",
                                   accessibilityDescription: "JARVIS")
            button.action = #selector(togglePopover)
            button.target = self
        }

        // Popover mit SwiftUI-Inhalt
        popover = NSPopover()
        popover.contentSize = NSSize(width: 420, height: 540)
        popover.behavior = .transient
        let view = ChatView().environmentObject(state)
        popover.contentViewController = NSHostingController(rootView: view)

        // Globaler Hotkey ⌥-Space
        registerHotkey()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let m = globalMonitor { NSEvent.removeMonitor(m) }
        if let m = localMonitor { NSEvent.removeMonitor(m) }
    }

    @objc private func togglePopover() {
        if popover.isShown {
            popover.performClose(nil)
        } else if let button = statusItem.button {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func registerHotkey() {
        // ⌥-Space: keyCode 49 = Space, Modifier .option
        let isHotkey: (NSEvent) -> Bool = { event in
            event.keyCode == 49 && event.modifierFlags.contains(.option)
        }

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard isHotkey(event) else { return }
            Task { @MainActor [weak self] in self?.togglePopover() }
        }

        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard isHotkey(event) else { return event }
            Task { @MainActor [weak self] in self?.togglePopover() }
            return nil
        }
    }
}
