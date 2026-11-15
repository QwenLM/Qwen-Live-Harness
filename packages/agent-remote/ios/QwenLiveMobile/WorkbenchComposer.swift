import SwiftUI

struct WorkbenchComposer: View {
    @EnvironmentObject private var model: AppModel
    let contextID: UUID
    let state: RemoteState
    let awaitingConfirmation: Bool
    @FocusState.Binding var editing: Bool
    @State private var showSettings = false
    @State private var importingImage = false

    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var voice = VoiceInputModel()
    @State private var voiceTask: Task<Void, Never>?

    var body: some View {
        composer
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopVoice() } }
        .onChange(of: state.runId) { _, _ in stopVoice(); showSettings = false }
        .onChange(of: model.contextID) { _, _ in stopVoice(); showSettings = false }
        .onChange(of: model.pending?.id) { _, request in if request != nil { stopVoice() } }
        .onDisappear { stopVoice() }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                Form {
                    Section { WorkingFolderButton(project: model.selectedProject) }
                    Section(tr("agent")) {
                        Picker(tr("agent"), selection: $model.backend) {
                            ForEach(state.backends) { Text($0.name).tag($0.id) }
                        }.pickerStyle(.segmented).accessibilityIdentifier("backendPicker")
                    }
                }
                .navigationTitle(tr("runSettings")).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(tr("done")) { showSettings = false }.accessibilityIdentifier("closeRunSettings")
                    }
                }
            }
            .presentationDetents([.medium, .large])
            .onChange(of: model.state?.runId) { _, _ in showSettings = false }
        }
    }

    private var composer: some View {
        let backend = state.backends.first { $0.id == model.backend }
        let locked = model.busy || model.pending != nil || awaitingConfirmation
        let supportsImages = state.capabilities?.imageAttachments == true && backend?.imageInput != false
        let hasInput = !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.draftImages.isEmpty
        let canSend = !locked && voice.phase == .idle && !importingImage && hasInput && model.connectionError == nil && backend != nil &&
            model.workingFolderAvailable && (model.draftImages.isEmpty || supportsImages)
        let images = Binding(get: { model.draftImages }, set: { images in
            guard state.runId == model.state?.runId else { return }
            model.setImages(images, expectedContext: contextID)
        })
        return VStack(alignment: .leading, spacing: 4) {
            Button { editing = false; showSettings = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "folder")
                    Text(model.selectedProject?.name ?? tr("chooseWorkingFolder")).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text(backend?.name ?? tr("agent")).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption)
                }.font(.subheadline).foregroundStyle(.secondary)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(locked || importingImage || voice.phase != .idle)
                .accessibilityIdentifier("runSettings")
            if !model.workingFolderAvailable { ErrorNote(text: tr("directory_unavailable")) }
            if !images.wrappedValue.isEmpty {
                ImageAttachmentStrip(images: images.wrappedValue, store: model.imageStore,
                                     remove: locked || voice.phase != .idle ? nil : { image in images.wrappedValue.removeAll { $0.id == image.id } })
                if !supportsImages {
                    ErrorNote(text: tr(state.capabilities?.imageAttachments == true ? "image_input_unsupported" : "updateGatewayImages"))
                }
            }
            if voice.phase != .idle {
                Label(tr(voice.phase == .authorizing ? "dictationAuthorizing" : "dictationListening"), systemImage: "waveform")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8)
            }
            if let error = voice.error {
                HStack {
                    ErrorNote(text: error)
                    Button { voice.clearError() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                        .accessibilityLabel(tr("dismiss"))
                }
            }
            ComposerBar {
                if state.capabilities?.imageAttachments == true {
                    ImageAttachmentPicker(images: images, importing: $importingImage, store: model.imageStore,
                                          disabled: locked || voice.phase != .idle || !supportsImages)
                        .id(state.runId)
                }
            } field: {
                TextField(tr("firstMessagePrompt"), text: Binding(get: { model.draft }, set: {
                    guard model.contextID == contextID, model.state?.runId == state.runId else { return }
                    model.draft = $0
                }), axis: .vertical)
                    .focused($editing).disabled(locked || voice.phase != .idle).accessibilityIdentifier("taskInput")
            } actions: {
                Button {
                    if voice.phase == .idle {
                        editing = false
                        let prefix = model.draft.isEmpty ? "" : model.draft + "\n"
                        let owner = contextID, run = state.runId
                        voiceTask = Task {
                            guard !Task.isCancelled, model.contextID == owner, model.state?.runId == run else { return }
                            await voice.start(localeIdentifier: assistant.dictationLanguage.localeIdentifier) { text in
                                guard !text.isEmpty, model.contextID == owner, model.state?.runId == run,
                                      model.pending == nil, !model.busy else { return }
                                model.draft = prefix + text
                            }
                        }
                    } else { stopVoice() }
                } label: {
                    Image(systemName: voice.phase == .idle ? "mic" : "stop.fill")
                        .font(.system(size: 20)).frame(width: 44, height: 44)
                }.disabled(locked || importingImage)
                    .accessibilityLabel(tr(voice.phase == .idle ? "voiceInput" : "stopVoiceInput"))
                    .accessibilityIdentifier("workbenchVoice")
                Button {
                    editing = false
                    Task {
                        guard model.state?.runId == state.runId else { return }
                        await model.submit(expectedContext: contextID)
                    }
                } label: {
                    Group {
                        if model.busy { ProgressView() }
                        else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                    }.frame(width: 44, height: 44)
                }.disabled(!canSend).accessibilityLabel(tr("sendMessage")).accessibilityIdentifier("sendTask")
            }
        }
    }

    private func stopVoice() { voiceTask?.cancel(); voiceTask = nil; voice.stop() }
}
