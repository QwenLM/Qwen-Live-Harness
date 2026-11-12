import AppKit
import SwiftUI
import CoreImage.CIFilterBuiltins
import ServiceManagement
import AgentRemoteMacCore

struct DashboardView: View {
    @ObservedObject var model: DesktopModel
    @State private var confirmStop = false
    private let green = Color(red: 0.12, green: 0.36, blue: 0.31)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    if let url = Bundle.main.url(forResource: "BrandMark", withExtension: "png"),
                       let image = NSImage(contentsOf: url) {
                        Image(nsImage: image).renderingMode(.template).resizable().scaledToFit()
                            .frame(width: 44, height: 32).foregroundStyle(green).accessibilityLabel("Agent Remote")
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Agent Remote").font(.title2.bold())
                        Text(model.snapshot?.name ?? tr("loading")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Circle().fill(model.online ? green : Color.secondary).frame(width: 9, height: 9)
                }
                HStack {
                    Label(tr(model.online ? "running" : model.snapshot?.loaded == true ? "recovering" : "stopped"), systemImage: model.online ? "checkmark.shield.fill" : "pause.circle")
                        .foregroundStyle(model.online ? green : Color.secondary).font(.headline)
                    Spacer()
                    if model.snapshot?.permissionMode == "allow-all" { Text(tr("automaticApprovals")).font(.caption).foregroundStyle(green) }
                }
                if let snapshot = model.snapshot, snapshot.online {
                    Text(String(format: tr("taskCounts"), snapshot.activeTasks, snapshot.totalTasks)).font(.caption).foregroundStyle(.secondary)
                }

                GroupBox {
                    VStack(spacing: 12) {
                        if let pairing = model.pairing {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                if pairing.expiry > context.date {
                                    if let image = qr(pairing.link) { Image(nsImage: image).interpolation(.none).resizable().frame(width: 190, height: 190).accessibilityLabel(tr("pairingQR")) }
                                    Text(tr("scanInPhone")).font(.subheadline)
                                    Text(pairing.url).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                                    Text(String(format: tr("expiresMinutes"), max(1, Int(ceil(pairing.expiry.timeIntervalSince(context.date) / 60))))).font(.caption).foregroundStyle(.secondary)
                                } else { Label(tr("pairingExpired"), systemImage: "clock").foregroundStyle(.secondary).padding() }
                            }
                            HStack {
                                Button(tr(model.copied ? "copied" : "copyLink")) { model.copyPairing() }.accessibilityIdentifier("copyPairing")
                                Spacer()
                                Button(tr("refreshCode")) { Task { await model.showPairing() } }.accessibilityIdentifier("refreshPairing")
                            }
                        } else {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 42, weight: .light)).foregroundStyle(green).padding(.top, 8)
                            Text(tr(model.online ? "readyToPair" : "startToPair")).foregroundStyle(.secondary)
                            if model.online { Button(tr("showPairing")) { Task { await model.showPairing() } }.buttonStyle(.borderedProminent).accessibilityIdentifier("showPairing") }
                        }
                    }.frame(maxWidth: .infinity).padding(10)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text(tr("agents")).font(.headline)
                    ForEach(model.snapshot?.agents ?? []) { agent in
                        HStack {
                            Label(agent.name, systemImage: "terminal")
                            Spacer()
                            Text(agentLabel(agent)).font(.caption).foregroundStyle(agent.installed ? green : Color.secondary)
                        }.help(agent.executable ?? tr("agentMissing"))
                    }
                    Text(tr("agentLoginHint")).font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                HStack {
                    Text(tr("projects")).font(.headline)
                    Spacer()
                    Button(tr("chooseProjects")) { model.chooseProjects() }.accessibilityIdentifier("chooseProjects")
                        .disabled(model.busy || (model.snapshot?.activeTasks ?? 0) > 0)
                }
                if model.snapshot?.config.projects.isEmpty != false {
                    Text(tr("chooseProjectsHint")).font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(model.snapshot?.config.projects ?? [], id: \.self) { project in
                        Label(project, systemImage: "folder").font(.caption).lineLimit(2).textSelection(.enabled)
                    }
                }
                Toggle(tr("launchAtLogin"), isOn: Binding(get: { model.loginEnabled }, set: { value in Task { await model.setLogin(value) } }))
                    .disabled(model.busy || model.snapshot?.config.projects.isEmpty != false).accessibilityIdentifier("launchAtLogin")
                if model.loginStatus == .requiresApproval {
                    Text(tr("loginApprovalHint")).font(.caption).foregroundStyle(.secondary)
                    Button(tr("openLoginSettings")) { model.openLoginSettings() }
                }
                if let error = model.error {
                    Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                }
                HStack {
                    if model.busy { ProgressView().controlSize(.small) }
                    if model.online || model.snapshot?.loaded == true {
                        if model.online {
                            Button(tr("restartService")) { Task { await model.start() } }.disabled((model.snapshot?.activeTasks ?? 0) > 0).accessibilityIdentifier("restartService")
                        } else {
                            Button(tr("refreshStatus")) { Task { await model.refresh(force: true) } }
                        }
                        Button(tr("stopService")) { confirmStop = true }.accessibilityIdentifier("stopService")
                    } else {
                        Button(tr("startService")) { Task { await model.start() } }.buttonStyle(.borderedProminent).disabled(!model.canStart).accessibilityIdentifier("startService")
                    }
                    Spacer()
                    Button(tr("logs")) { model.openLogs() }
                }.disabled(model.busy)
                HStack {
                    Text(tr("closeKeepsRunning")).font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button(tr("quitApp")) { NSApp.terminate(nil) }.buttonStyle(.plain).font(.caption2)
                }
            }.padding(20)
        }.tint(green).frame(minWidth: 380, idealWidth: 390, maxWidth: .infinity, maxHeight: .infinity)
            .alert(tr("stopService"), isPresented: $confirmStop) {
                Button(tr("stopService"), role: .destructive) { Task { await model.stop(confirmActive: true) } }
                Button(tr("cancel"), role: .cancel) {}
            } message: { Text(tr("stopExplanation")) }
    }
    private func agentLabel(_ agent: AgentStatus) -> String {
        if !agent.installed { return tr("notDetected") }
        switch agent.status { case "ready": return tr("agentReady"); case "starting": return tr("agentStarting"); case "unavailable": return tr("agentUnavailable"); default: return tr("detected") }
    }
    private func qr(_ link: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(link.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cg, size: output.extent.size)
    }
}
