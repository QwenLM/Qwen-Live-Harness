import SwiftUI

enum PersonalStyle {
    static let accent = Color("AccentColor")
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
}

struct PersonalAgentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var voice = VoiceInputModel()
    let openActivity: (ActivityLink) -> Void
    let openWorkbench: () -> Void
    @State private var latestSaved: UUID?
    @State private var selectedInput: AssistantInput?
    @State private var showLive = false
    @State private var inputSource = AssistantInput.Source.text
    @State private var voiceTask: Task<Void, Never>?
    @State private var importingImage = false
    @FocusState private var editing: Bool

    private var recent: [PersonalActivity] {
        PersonalActivity.recent(state: model.state, computerID: model.selectedComputerID,
                                contextID: model.contextID, inputs: assistant.inputs)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if !recent.isEmpty {
                        Text(tr("recentThreeThings")).font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 4)
                    }
                    ForEach(recent) { item in
                        RecentActivityCard(item: item, stale: item.link != nil && model.connectionError != nil) {
                            if case .input(let input) = item.content { selectedInput = input }
                            else if let link = item.link { openActivity(link) }
                        }
                    }
                    if let latestSaved, assistant.input(latestSaved) != nil {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(tr("assistantCaptureReceipt")).font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Button { self.latestSaved = nil } label: {
                                    Image(systemName: "xmark").font(.caption).frame(width: 44, height: 44)
                                }.accessibilityLabel(tr("dismissReceipt"))
                            }
                            Text(tr("assistantCapturedLocally")).font(.subheadline).foregroundStyle(.secondary)
                                .accessibilityIdentifier("assistantReceipt")
                            Button(tr("viewSavedInput")) { selectedInput = assistant.input(latestSaved) }
                                .font(.subheadline).frame(minHeight: 44)
                        }.padding(.top, 12).id("receipt")
                    }
                    if let error = assistant.error { ErrorNote(text: error) }
                    if let error = voice.error {
                        VStack(alignment: .leading) {
                            ErrorNote(text: error)
                            Button(tr("dismiss")) { voice.clearError() }.font(.footnote).frame(minHeight: 44)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 22).padding(.vertical, 18)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: latestSaved) { _, value in
                if value != nil { withAnimation { proxy.scrollTo("receipt", anchor: .bottom) } }
            }
        }
        .background(PersonalStyle.background)
        .navigationTitle(tr("personalAgent"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { stopVoice(); editing = false; showLive = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "waveform")
                        Text("Live")
                    }.foregroundStyle(PersonalStyle.accent)
                }.disabled(voice.phase != .idle).accessibilityIdentifier("assistantLive")
                    .accessibilityLabel("Omni Live")
            }
        }
        .bottomComposer { composer }
        .sheet(item: $selectedInput) { input in SavedInputDetail(inputID: input.id) }
        .sheet(isPresented: $showLive) { OmniLiveView() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopVoice() } }
        .onDisappear { stopVoice() }
    }

    private var composer: some View {
        let hasInput = !assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !assistant.draftImages.isEmpty
        let images = Binding(get: { assistant.draftImages }, set: { assistant.setDraftImages($0) })
        return VStack(alignment: .leading, spacing: 8) {
            if recent.isEmpty && !editing && !hasInput && voice.phase == .idle {
                Text(tr("assistantEmpty")).font(.title2.weight(.medium))
                    .padding(.leading, 6).padding(.bottom, 8)
                    .accessibilityIdentifier("assistantEmpty")
            }
            WorkingFolderButton(project: model.selectedProject, disabled: voice.phase != .idle, connectComputer: openWorkbench)
            if !images.wrappedValue.isEmpty {
                ImageAttachmentStrip(images: images.wrappedValue, store: assistant.imageStore, remove: { image in
                    assistant.setDraftImages(assistant.draftImages.filter { $0.id != image.id })
                })
            }
            if voice.phase != .idle {
                Label(tr(voice.phase == .authorizing ? "dictationAuthorizing" : "dictationListening"), systemImage: "waveform")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8)
            }
            ComposerBar {
                ImageAttachmentPicker(images: images, importing: $importingImage, store: assistant.imageStore,
                                      disabled: voice.phase != .idle)
            } field: {
                TextField(tr("assistantInputPlaceholder"), text: Binding(get: { assistant.draft }, set: {
                    assistant.draft = $0; inputSource = .text
                }), axis: .vertical)
                    .focused($editing).disabled(voice.phase != .idle)
                    .accessibilityIdentifier("assistantInput")
            } actions: {
                Button {
                    if voice.phase == .idle {
                        editing = false
                        let prefix = assistant.draft.isEmpty ? "" : assistant.draft + "\n"
                        voiceTask = Task {
                            await voice.start(localeIdentifier: assistant.dictationLanguage.localeIdentifier) { text in
                                guard !text.isEmpty else { return }
                                inputSource = .voice; assistant.draft = prefix + text
                            }
                        }
                    } else { stopVoice() }
                } label: {
                    Image(systemName: voice.phase == .idle ? "mic" : "stop.fill")
                        .font(.system(size: 20)).frame(width: 44, height: 44)
                }.accessibilityLabel(tr(voice.phase == .idle ? "voiceInput" : "stopVoiceInput"))
                    .accessibilityIdentifier("assistantVoice")
                if hasInput {
                    Button {
                        let workspace = model.selectedComputer.flatMap { computer in
                            model.selectedProject.map { AssistantWorkspaceContext(computerID: computer.id, computerName: computer.displayName, project: $0) }
                        }
                        if let saved = assistant.saveInput(source: inputSource, workspace: workspace) {
                            latestSaved = saved.id; inputSource = .text; editing = false
                        }
                    } label: {
                        Image(systemName: "checkmark.circle.fill").font(.title)
                            .frame(width: 44, height: 44)
                    }.disabled(voice.phase != .idle || importingImage)
                        .accessibilityLabel(tr("saveAssistantInput"))
                        .accessibilityIdentifier("assistantSend")
                }
            }
        }
    }

    private func stopVoice() { voiceTask?.cancel(); voiceTask = nil; voice.stop() }
}

private struct RecentActivityCard: View {
    let item: PersonalActivity
    let stale: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label(stale ? tr("lastKnownState") : item.category, systemImage: item.symbol)
                    Spacer()
                    Text(item.date, style: .relative).lineLimit(1)
                }.font(.caption2).foregroundStyle(.secondary)
                Text(item.title).font(.body.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                Text(item.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                .background(PersonalStyle.card, in: RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(.plain).accessibilityElement(children: .combine).accessibilityIdentifier("recent-" + item.id)
    }
}

struct SavedInputDetail: View {
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.dismiss) private var dismiss
    let inputID: UUID
    @State private var confirmDelete = false
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Group {
                if let input = assistant.input(inputID) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            Label(tr("assistantSavedInput"), systemImage: input.source == .voice ? "mic" : "tray")
                                .font(.caption).foregroundStyle(.secondary)
                            if !input.text.isEmpty { Text(input.text).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            if !input.images.isEmpty { ImageAttachmentStrip(images: input.images, store: assistant.imageStore) }
                            if let workspace = input.workspace {
                                VStack(alignment: .leading, spacing: 6) {
                                    Label(workspace.computerName, systemImage: "laptopcomputer")
                                    Label(workspace.project.path, systemImage: "folder").textSelection(.enabled)
                                }.font(.footnote).foregroundStyle(.secondary)
                            }
                            Text(input.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            Text(tr("assistantInputPendingSummary")).font(.footnote).foregroundStyle(.secondary)
                            if !input.text.isEmpty {
                                Button {
                                    UIPasteboard.general.string = input.text; copied = true
                                } label: { Label(tr(copied ? "copiedInput" : "copyInput"), systemImage: "doc.on.doc") }
                                    .frame(minHeight: 44)
                                ShareLink(item: input.text).frame(minHeight: 44)
                            }
                            Button(tr("deleteSavedInput"), role: .destructive) { confirmDelete = true }.frame(minHeight: 44)
                        }.padding(24)
                    }
                } else { ContentUnavailableView(tr("savedInputUnavailable"), systemImage: "tray") }
            }
            .navigationTitle(tr("savedInputDetail")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { dismiss() } } }
            .confirmationDialog(tr("deleteSavedInput"), isPresented: $confirmDelete, titleVisibility: .visible) {
                Button(tr("deleteSavedInput"), role: .destructive) { assistant.deleteInput(inputID); dismiss() }
            } message: { Text(tr("deleteSavedInputDetail")) }
        }
    }
}
