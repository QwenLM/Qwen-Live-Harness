import SwiftUI

struct OmniLiveSettingsView: View {
    @EnvironmentObject private var settings: OmniLiveSettings
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var workspace = ""
    @State private var region = "cn-beijing"
    @State private var confirmDelete = false
    @State private var saved = false
    private enum Field { case key, workspace }
    @FocusState private var editing: Field?
    var body: some View {
        Form {
            Section {
                Label("Qwen3.8 Omni Flash Realtime", systemImage: "waveform")
                Text(tr("liveKeyLocalDetail")).font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(tr("liveAPIKey")).font(.caption).foregroundStyle(.secondary)
                    SecureField(tr(settings.configured ? "liveReplaceKey" : "liveAPIKey"), text: $key)
                        .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($editing, equals: .key).privacySensitive().accessibilityIdentifier("liveAPIKey")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(tr("liveWorkspace")).font(.caption).foregroundStyle(.secondary)
                    TextField(tr("liveWorkspace"), text: $workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($editing, equals: .workspace).accessibilityIdentifier("liveWorkspace")
                }
                Picker(tr("liveRegion"), selection: $region) {
                    Text(tr("liveBeijing")).tag("cn-beijing")
                    Text(tr("liveSingapore")).tag("ap-southeast-1")
                }
            } header: { Text("DashScope") } footer: { Text(tr("liveWorkspaceHint")) }
            Section {
                Button(tr("save")) {
                    saved = settings.save(apiKey: key, workspace: workspace, region: region)
                    if saved { key = ""; editing = nil }
                }.accessibilityIdentifier("saveLiveConfiguration")
                if saved && settings.configured && key.isEmpty && workspace == settings.workspace && region == settings.region {
                    Label(tr("liveConfigurationSaved"), systemImage: "checkmark.circle").foregroundStyle(.secondary)
                }
                if let error = settings.error { ErrorNote(text: error) }
                if settings.configured {
                    Button(tr("liveDeleteKey"), role: .destructive) { confirmDelete = true }.accessibilityIdentifier("deleteLiveKey")
                }
            }
            Section { Link(tr("liveConnectionGuide"), destination: URL(string: "https://help.aliyun.com/zh/model-studio/omni-realtime-websocket-access")!) }
        }
        .navigationTitle(tr("liveConfigure")).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { key = ""; dismiss() } } }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { workspace = settings.workspace; region = settings.region }
        .onDisappear { key = "" }
        .confirmationDialog(tr("liveDeleteKey"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(tr("liveDeleteKey"), role: .destructive) { settings.delete(); key = ""; workspace = ""; saved = false }
        } message: { Text(tr("liveDeleteKeyDetail")) }
    }
}
