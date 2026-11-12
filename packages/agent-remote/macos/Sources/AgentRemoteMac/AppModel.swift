import AppKit
import SwiftUI
import ServiceManagement
import AgentRemoteMacCore

func tr(_ key: String) -> String { NSLocalizedString(key, comment: "") }
private struct OperationReply: Decodable { let ok: Bool }

@MainActor
final class DesktopModel: ObservableObject {
    @Published var snapshot: DesktopSnapshot?
    @Published var pairing: PairingInfo?
    @Published var busy = false
    @Published var error: String?
    @Published var loginStatus = SMAppService.mainApp.status
    @Published var copied = false
    private let bridge = GatewayBridge(bundle: Bundle.main.bundleURL)
    private var refreshing = false
    private var refreshEpoch = UUID()

    var online: Bool { snapshot?.online == true }
    var loginEnabled: Bool { snapshot?.config.launchAtLogin == true && loginStatus == .enabled }
    var canStart: Bool { snapshot?.config.projects.isEmpty == false && snapshot?.agents.contains(where: { $0.installed }) == true }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
        }
    }
    func refresh(force: Bool = false) async {
        guard force || (!refreshing && !busy) else { return }
        if force { refreshEpoch = UUID() }
        let epoch = refreshEpoch
        refreshing = true; defer { if epoch == refreshEpoch { refreshing = false } }
        do {
            let next: DesktopSnapshot = try await bridge.request(["snapshot"])
            guard epoch == refreshEpoch else { return }
            if next.runId != snapshot?.runId || !next.online { pairing = nil }
            snapshot = next; loginStatus = SMAppService.mainApp.status
        } catch { if epoch == refreshEpoch && self.error == nil { self.error = error.localizedDescription } }
    }
    private func perform(_ action: @escaping () async throws -> Void) async {
        guard !busy else { return }
        busy = true; error = nil; defer { busy = false }
        refreshEpoch = UUID(); refreshing = false
        do { try await action() } catch { self.error = error.localizedDescription }
        await refresh(force: true)
    }
    func start() async {
        await perform {
            let _: OperationReply = try await self.bridge.request(["start"])
            for _ in 0..<15 {
                await self.refresh(force: true)
                if self.online { break }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            if self.snapshot?.config.launchAtLogin != false { try self.registerLogin() }
        }
        if online && error == nil { await showPairing() }
    }
    func stop(confirmActive: Bool) async {
        await perform {
            let _: OperationReply = try await self.bridge.request(["stop"] + (confirmActive ? ["--confirm-active"] : []))
            self.pairing = nil
        }
    }
    func showPairing() async {
        await perform {
            let next: PairingInfo = try await self.bridge.request(["pair"])
            guard next.runId == self.snapshot?.runId else { return }
            self.pairing = next; self.copied = false
        }
    }
    func chooseProjects() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = tr("chooseProjects")
        panel.prompt = tr("useFolders")
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
        panel.canCreateDirectories = true
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return }
        let arguments = ["configure"] + panel.urls.flatMap { ["--project", $0.path] }
        Task { await perform { let _: OperationReply = try await self.bridge.request(arguments) } }
    }
    func setLogin(_ enabled: Bool) async {
        await perform {
            let _: OperationReply = try await self.bridge.request(["login", enabled ? "on" : "off"])
            if enabled { try self.registerLogin() }
            else if ProcessInfo.processInfo.environment["AGENT_REMOTE_DISABLE_LOGIN_REGISTRATION"] != "1", SMAppService.mainApp.status != .notRegistered { try await SMAppService.mainApp.unregister() }
            self.loginStatus = SMAppService.mainApp.status
        }
    }
    private func registerLogin() throws {
        if ProcessInfo.processInfo.environment["AGENT_REMOTE_DISABLE_LOGIN_REGISTRATION"] == "1" { return }
        if SMAppService.mainApp.status != .enabled && SMAppService.mainApp.status != .requiresApproval { try SMAppService.mainApp.register() }
        loginStatus = SMAppService.mainApp.status
        if loginStatus == .notFound { throw BridgeError.failed(tr("loginNotFound")) }
    }
    func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
    func copyPairing() {
        guard let pairing else { return }
        guard pairing.expiry > Date() else { error = tr("pairingExpired"); return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(pairing.link, forType: .string); copied = true
    }
    func openLogs() {
        guard let directory = snapshot?.directory else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: directory))
    }
}
