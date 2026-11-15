import SwiftUI

struct OmniLiveView: View {
    @EnvironmentObject private var settings: OmniLiveSettings
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var live = OmniLiveModel()
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                VStack(spacing: 12) {
                    Image(systemName: live.phase == .speaking ? "waveform" : "waveform.circle")
                        .font(.system(size: 64, weight: .ultraLight)).foregroundStyle(PersonalStyle.accent)
                        .symbolEffect(.variableColor, isActive: live.active)
                    Text(tr("livePhase_" + live.phase.rawValue)).font(.title3.weight(.semibold))
                        .accessibilityIdentifier("liveStatus")
                    Text("Qwen3.8 Omni Flash Realtime").font(.caption).foregroundStyle(.secondary)
                    if live.active, ![.authorizing, .connecting].contains(live.phase) {
                        ProgressView(value: live.inputLevel).tint(PersonalStyle.accent).frame(width: 180)
                            .accessibilityLabel(tr("liveMicrophoneLevel"))
                        Text(tr(live.muted ? "liveMicrophoneMuted" : "liveMicrophoneLevel")).font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(.top, 16)
                if let error = live.error { ErrorNote(text: error).padding(.horizontal) }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if live.lines.isEmpty { Text(tr("liveStartHint")).foregroundStyle(.secondary).padding(.vertical, 28) }
                            ForEach(live.lines) { line in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(tr(line.user ? "liveYou" : "liveOmni")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    Text(line.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(14).background(line.user ? PersonalStyle.card : PersonalStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                                    .id(line.id).accessibilityIdentifier(line.user ? "liveUserTranscript" : "liveAssistantTranscript")
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }.padding(.horizontal, 20)
                    }.onChange(of: live.lines.last?.text) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                }
                VStack(spacing: 12) {
                    DisclosureGroup(tr("liveDiagnostics")) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(live.diagnostics).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                            Button(tr("liveCopyDiagnostics")) { UIPasteboard.general.string = live.diagnostics }.font(.caption)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.font(.caption).accessibilityIdentifier("liveDiagnostics")
                    Text(tr("livePrivacy")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    HStack(spacing: 24) {
                        if live.active {
                            Button { live.toggleMute() } label: {
                                Label(tr(live.muted ? "liveUnmute" : "liveMute"), systemImage: live.muted ? "mic.slash.fill" : "mic.fill")
                                    .frame(minHeight: 44)
                            }.buttonStyle(.bordered).disabled([.authorizing, .connecting].contains(live.phase)).accessibilityIdentifier("liveMute")
                            Button(role: .destructive) { live.stop() } label: {
                                Label(tr("liveHangUp"), systemImage: "phone.down.fill").frame(minHeight: 44)
                            }.buttonStyle(.borderedProminent).tint(.red).accessibilityIdentifier("liveHangUp")
                        } else {
                            Button { start() } label: {
                                Label(tr("liveStart"), systemImage: "phone.fill").frame(maxWidth: .infinity, minHeight: 44)
                            }.buttonStyle(.borderedProminent).disabled(!settings.configured)
                                .accessibilityIdentifier("liveStart")
                        }
                    }
                    if !settings.configured {
                        Button(tr("liveConfigure")) { showSettings = true }.frame(minHeight: 44).accessibilityIdentifier("liveConfigure")
                    }
                }.padding(.horizontal, 24).padding(.bottom, 12)
            }
            .background(PersonalStyle.background).navigationTitle("Omni Live").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { showSettings = true } label: { Image(systemName: "gearshape") }.disabled(live.active).accessibilityLabel(tr("liveConfigure")) }
                ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { live.stop(); dismiss() }.accessibilityIdentifier("closeLive") }
            }
        }
        .sheet(isPresented: $showSettings) { NavigationStack { OmniLiveSettingsView() } }
        .onChange(of: scenePhase) { _, phase in if phase == .background { live.interrupt() } }
        .onChange(of: settings.revision) { _, _ in if live.active { live.stop() } }
        .onDisappear { live.stop() }
        .interactiveDismissDisabled(live.active)
    }
    private func start() {
        live.start { try await settings.credentials() }
    }
}
