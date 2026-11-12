import AppKit
import SwiftUI
import AgentRemoteMacCore
import Carbon

@main
enum AgentRemoteApplication {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = DesktopModel()
    private var item: NSStatusItem!
    private var popover: NSPopover!
    private var window: NSWindow!
    private var polling: Task<Void, Never>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let url = Bundle.main.url(forResource: "BrandMark", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            image.size = NSSize(width: 22, height: 16)
            image.isTemplate = true
            item.button?.image = image
            item.button?.imageScaling = .scaleProportionallyDown
            item.button?.setAccessibilityLabel("Agent Remote")
        } else {
            item.button?.image = NSImage(systemSymbolName: "laptopcomputer.and.iphone", accessibilityDescription: "Agent Remote")
        }
        item.button?.target = self; item.button?.action = #selector(togglePanel)
        item.button?.toolTip = "Agent Remote"
        popover = NSPopover(); popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: DashboardView(model: model))
        popover.contentSize = NSSize(width: 390, height: 680)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 740), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Agent Remote"; window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: DashboardView(model: model))
        polling = Task { await model.poll() }
        // Finder launches show a usable first-run window. At login the menu
        // item remains quiet; the gateway is supervised independently.
        let event = NSAppleEventManager.shared().currentAppleEvent
        let atLogin = event?.eventID == kAEOpenApplication && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        if !atLogin && !ProcessInfo.processInfo.arguments.contains("--background") { showWindow() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    @objc private func togglePanel() {
        if popover.isShown { popover.performClose(nil) }
        else if let button = item.button { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY); NSApp.activate(ignoringOtherApps: true) }
    }
    private func showWindow() { window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
}
