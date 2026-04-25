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
    private var dialogGlobalMonitor: Any?
    private var dialogLocalMonitor: Any?
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
        let savedW = UserDefaults.standard.object(forKey: "popoverWidth") as? Double ?? 520
        let savedH = UserDefaults.standard.object(forKey: "popoverHeight") as? Double ?? 680
        popover.contentSize = NSSize(width: savedW, height: savedH)
        popover.behavior = .transient
        let view = ChatView().environmentObject(state)
        popover.contentViewController = NSHostingController(rootView: view)

        // Resize-Notifications aus ChatView verarbeiten
        NotificationCenter.default.addObserver(
            forName: .jarvisResizePopover,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let w = note.userInfo?["w"] as? CGFloat,
                  let h = note.userInfo?["h"] as? CGFloat else { return }
            Task { @MainActor [weak self] in
                self?.popover.contentSize = NSSize(width: w, height: h)
            }
        }

        // Hotkeys registrieren + bei Änderung neu binden
        registerHotkey()
        registerDialogHotkey()
        Publishers.CombineLatest3(state.$hotkeyKeyCode, state.$hotkeyModifiers, state.$hotkeyEnabled)
            .dropFirst()
            .sink { [weak self] _, _, _ in
                Task { @MainActor in self?.registerHotkey() }
            }
            .store(in: &cancellables)
        Publishers.CombineLatest3(state.$dialogHotkeyKeyCode, state.$dialogHotkeyModifiers, state.$dialogHotkeyEnabled)
            .dropFirst()
            .sink { [weak self] _, _, _ in
                Task { @MainActor in self?.registerDialogHotkey() }
            }
            .store(in: &cancellables)
    }

    func applicationWillTerminate(_ notification: Notification) {
        removeMonitors()
        removeDialogMonitors()
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

    private func removeDialogMonitors() {
        if let m = dialogGlobalMonitor { NSEvent.removeMonitor(m); dialogGlobalMonitor = nil }
        if let m = dialogLocalMonitor  { NSEvent.removeMonitor(m); dialogLocalMonitor  = nil }
    }

    @objc private func toggleDialog() {
        state.dialogMode.toggle()
        // Wenn Dialog gerade gestartet wurde und Popover zu ist: aufpoppen, damit
        // User den Status sieht ("Höre zu…" / "JARVIS spricht…")
        if state.dialogMode, !popover.isShown, let button = statusItem.button {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    private func registerDialogHotkey() {
        removeDialogMonitors()
        guard state.dialogHotkeyEnabled else {
            print("[hotkey-dialog] disabled, skipping registration")
            return
        }

        let targetKeyCode = UInt16(state.dialogHotkeyKeyCode)
        let targetMods = NSEvent.ModifierFlags(rawValue: UInt(state.dialogHotkeyModifiers))
            .intersection(KeyMapper.relevantModifierMask)
        print("[hotkey-dialog] register keyCode=\(targetKeyCode) mods=\(targetMods.rawValue)")

        let isHotkey: (NSEvent) -> Bool = { event in
            guard event.keyCode == targetKeyCode else { return false }
            let mods = event.modifierFlags.intersection(KeyMapper.relevantModifierMask)
            return mods == targetMods
        }

        dialogGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            print("[hotkey-dialog] GLOBAL keyCode=\(event.keyCode) mods=\(event.modifierFlags.rawValue) match=\(isHotkey(event))")
            guard isHotkey(event) else { return }
            Task { @MainActor [weak self] in self?.toggleDialog() }
        }
        dialogLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard isHotkey(event) else { return event }
            print("[hotkey-dialog] LOCAL match → toggle")
            Task { @MainActor [weak self] in self?.toggleDialog() }
            return nil
        }
        if dialogGlobalMonitor == nil {
            print("[hotkey-dialog] ⚠️  addGlobalMonitorForEvents returned nil — Input-Monitoring-Permission fehlt für diese Build-Signatur!")
        }
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
