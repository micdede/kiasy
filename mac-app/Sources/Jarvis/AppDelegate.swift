import SwiftUI
import AppKit
import Combine

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    let state = AppState()
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var cancellables = Set<AnyCancellable>()

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

        // Hotkey registrieren + bei Änderung neu binden
        registerHotkey()
        Publishers.CombineLatest3(state.$hotkeyKeyCode, state.$hotkeyModifiers, state.$hotkeyEnabled)
            .dropFirst()
            .sink { [weak self] _, _, _ in
                Task { @MainActor in self?.registerHotkey() }
            }
            .store(in: &cancellables)
    }

    func applicationWillTerminate(_ notification: Notification) {
        removeMonitors()
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

    private func removeMonitors() {
        if let m = globalMonitor { NSEvent.removeMonitor(m); globalMonitor = nil }
        if let m = localMonitor  { NSEvent.removeMonitor(m); localMonitor = nil }
    }

    private func registerHotkey() {
        removeMonitors()
        guard state.hotkeyEnabled else { return }

        let targetKeyCode = UInt16(state.hotkeyKeyCode)
        let targetMods = NSEvent.ModifierFlags(rawValue: UInt(state.hotkeyModifiers))
            .intersection(KeyMapper.relevantModifierMask)

        let isHotkey: (NSEvent) -> Bool = { event in
            guard event.keyCode == targetKeyCode else { return false }
            let mods = event.modifierFlags.intersection(KeyMapper.relevantModifierMask)
            return mods == targetMods
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
