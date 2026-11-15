import SwiftUI

/// The assistant's primary surface. Opening the tab never starts capture.
struct OmniLiveView: View {
    @EnvironmentObject private var settings: OmniLiveSettings
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var textSize
    @StateObject private var live = OmniLiveModel()
    @State private var showSettings = false
    @State private var showDetails = false

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 28) {
                        presence
                        if let error = live.error { ErrorNote(text: error) }
                        ForEach(live.lines) { line in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(tr(line.user ? "liveYou" : "liveOmni"))
                                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                Text(line.text).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(16)
                            .background(line.user ? PersonalStyle.card : Color.clear, in: RoundedRectangle(cornerRadius: 18))
                            .id(line.id).accessibilityIdentifier(line.user ? "liveUserTranscript" : "liveAssistantTranscript")
                        }
                        if textSize.isAccessibilitySize { controls }
                        if !live.lines.isEmpty { Color.clear.frame(height: 1).id("bottom") }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 28)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height,
                           alignment: live.lines.isEmpty ? .center : .top)
                }
                .onChange(of: live.lines.last?.text) { _, _ in
                    if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) }
                    else { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                }
            }
        }
        .background(PersonalStyle.background)
        .navigationTitle(tr("personalAgent")).navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !textSize.isAccessibilitySize {
                controls.padding(.horizontal, 28).padding(.top, 12).padding(.bottom, 18)
                    .frame(maxWidth: 640).frame(maxWidth: .infinity)
                    .background(PersonalStyle.background)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3") }
                    .disabled(live.active).accessibilityLabel(tr("liveConfigure"))
                    .accessibilityIdentifier("assistantLiveSettings")
            }
        }
        .sheet(isPresented: $showSettings) { NavigationStack { OmniLiveSettingsView() } }
        .sheet(isPresented: $showDetails) { details }
        .onChange(of: scenePhase) { _, phase in if phase == .background { live.interrupt() } }
        .onChange(of: settings.revision) { _, _ in if live.active { live.stop() } }
        .onDisappear { if live.active { live.stop() } }
    }

    private var presence: some View {
        VStack(spacing: 20) {
            ZStack {
                Circle().fill(PersonalStyle.accent.opacity(0.08))
                Image(systemName: live.phase == .speaking ? "waveform" : "waveform.circle")
                    .font(.system(size: live.lines.isEmpty ? 66 : 42, weight: .ultraLight))
                    .foregroundStyle(PersonalStyle.accent)
                    .symbolEffect(.variableColor, isActive: live.active && !reduceMotion)
            }
            .frame(width: live.lines.isEmpty ? 144 : 88, height: live.lines.isEmpty ? 144 : 88)
            .accessibilityHidden(true)
            VStack(spacing: 10) {
                if live.lines.isEmpty && !live.active {
                    Text(tr("assistantVoiceGreeting")).font(.largeTitle.weight(.medium))
                        .accessibilityIdentifier("assistantVoiceGreeting")
                    Text(tr("liveStartHint")).font(.body).foregroundStyle(.secondary)
                }
                Text(tr("livePhase_" + live.phase.rawValue))
                    .font(live.active ? .title3.weight(.medium) : .caption)
                    .foregroundStyle(live.active ? .primary : .secondary)
                    .accessibilityIdentifier("liveStatus")
            }.multilineTextAlignment(.center)
            if live.active, ![.authorizing, .connecting].contains(live.phase) {
                VStack(spacing: 8) {
                    ProgressView(value: live.inputLevel).tint(PersonalStyle.accent).frame(width: 160)
                        .accessibilityLabel(tr("liveMicrophoneLevel"))
                    Text(tr(live.muted ? "liveMicrophoneMuted" : "liveMicrophoneLevel"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if live.active {
                HStack(spacing: 16) {
                    Button { live.toggleMute() } label: {
                        Label(tr(live.muted ? "liveUnmute" : "liveMute"), systemImage: live.muted ? "mic.slash.fill" : "mic.fill")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.bordered).disabled([.authorizing, .connecting].contains(live.phase))
                        .accessibilityIdentifier("liveMute")
                    Button(role: .destructive) { live.stop() } label: {
                        Label(tr("liveHangUp"), systemImage: "phone.down.fill")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.borderedProminent).tint(.red).accessibilityIdentifier("liveHangUp")
                }
            } else if settings.configured {
                Button { live.start { try await settings.credentials() } } label: {
                    Label(tr("liveStart"), systemImage: "waveform")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .accessibilityIdentifier("liveStart")
            } else {
                Button { showSettings = true } label: {
                    Label(tr("assistantSetUpVoice"), systemImage: "waveform")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .accessibilityIdentifier("liveConfigure")
            }
            Button(tr("liveConversationDetails")) { showDetails = true }
                .font(.caption).foregroundStyle(.secondary).frame(minHeight: 44)
                .accessibilityIdentifier("liveDetails")
        }
    }

    private var details: some View {
        NavigationStack {
            List {
                Section("Omni Live") {
                    Text("Qwen3.8 Omni Flash Realtime")
                    Text(tr("livePrivacy")).foregroundStyle(.secondary)
                }
                Section(tr("liveDiagnostics")) {
                    Text(live.diagnostics).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                    Button(tr("liveCopyDiagnostics")) { UIPasteboard.general.string = live.diagnostics }
                }.accessibilityIdentifier("liveDiagnostics")
            }
            .navigationTitle(tr("liveConversationDetails")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(tr("done")) { showDetails = false }.accessibilityIdentifier("closeLiveDetails")
                }
            }
        }
    }
}
