import SwiftUI

struct NewConversationView: View {
    @EnvironmentObject private var model: AppModel
    let contextID: UUID
    let openDraft: () -> Void
    @FocusState private var editing: Bool
    @State private var showSettings = false
    @State private var importingImage = false
    @State private var firstRequestID: String?
    @State private var opened: ConversationRoute?

    // Both a POST receipt and a later state refresh can confirm this page's first message.
    private var confirmation: ConversationRoute? {
        guard let route = model.confirmedStart, route.contextID == contextID,
              route.conversationID == firstRequestID else { return nil }
        return route
    }

    private var synchronizedRoute: ConversationRoute? {
        guard let route = confirmation, let state = model.state, state.runId == route.runID,
              state.tasks.contains(where: { $0.id == route.conversationID }) else { return nil }
        return route
    }

    var body: some View {
        Group {
            if let opened {
                ConversationDetail(route: opened, openDraft: openDraft)
            } else if let state = model.state, model.contextID == contextID {
                draftPage(state)
            } else {
                ProgressView(tr("loading"))
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .onReceive(model.$pending) { request in
            if opened == nil, model.contextID == contextID, let request, request.conversationId == nil {
                firstRequestID = request.id
            }
        }
        .onChange(of: synchronizedRoute) { _, route in
            if opened == nil, let route { editing = false; showSettings = false; opened = route }
        }
    }

    private func draftPage(_ state: RemoteState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let error = model.connectionError { ErrorNote(text: error) }
                if let error = model.actionError { ErrorNote(text: error) }
                if let confirmation {
                    if confirmation.runID == state.runId {
                        Text(tr("syncingFirstMessage")).foregroundStyle(.secondary)
                        Button(tr("retryConnection")) { Task { await model.refresh(expectedContext: contextID) } }
                    } else { ErrorNote(text: tr("taskUnavailableHint")) }
                } else if model.pending != nil && !model.busy {
                    PendingSubmissionNotice(contextID: contextID)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20)
        }
        .scrollDismissesKeyboard(.interactively)
        .bottomComposer { composer(state) }
        .navigationTitle(tr("newConversation")).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(tr("newConversation")).font(.headline)
                    Text([model.selectedComputer?.displayName, tr(state.permissionMode == "allow-all" ? "automaticPermissions" : "manualPermissions")]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .onAppear { editing = model.pending == nil && confirmation == nil }
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

    private func composer(_ state: RemoteState) -> some View {
        let backend = state.backends.first { $0.id == model.backend }
        let locked = model.busy || model.pending != nil || confirmation != nil
        let supportsImages = state.capabilities?.imageAttachments == true && backend?.imageInput != false
        let hasInput = !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.draftImages.isEmpty
        let canSend = !locked && !importingImage && hasInput && model.connectionError == nil && backend != nil &&
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
            }.buttonStyle(.plain).disabled(locked || importingImage)
                .accessibilityIdentifier("runSettings")
            if !model.workingFolderAvailable { ErrorNote(text: tr("directory_unavailable")) }
            if !images.wrappedValue.isEmpty {
                ImageAttachmentStrip(images: images.wrappedValue, store: model.imageStore,
                                     remove: locked ? nil : { image in images.wrappedValue.removeAll { $0.id == image.id } })
                if !supportsImages {
                    ErrorNote(text: tr(state.capabilities?.imageAttachments == true ? "image_input_unsupported" : "updateGatewayImages"))
                }
            }
            ComposerBar {
                if state.capabilities?.imageAttachments == true {
                    ImageAttachmentPicker(images: images, importing: $importingImage, store: model.imageStore,
                                          disabled: locked || !supportsImages)
                        .id(state.runId)
                }
            } field: {
                TextField(tr("firstMessagePrompt"), text: $model.draft, axis: .vertical)
                    .focused($editing).disabled(locked).accessibilityIdentifier("taskInput")
            } actions: {
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
}
