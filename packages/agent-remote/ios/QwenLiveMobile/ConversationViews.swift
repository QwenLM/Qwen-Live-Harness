import SwiftUI

struct ConversationDetail: View {
    @EnvironmentObject private var model: AppModel
    let route: ConversationRoute
    let openConversation: (ConversationRoute) -> Void
    private struct StopTarget { let task: RemoteTask; let runID: String }
    @State private var stopTarget: StopTarget?
    @State private var showStop = false
    @State private var importingImage = false
    @State private var newFolder: RemoteProject?
    @State private var startedConversation: ConversationRoute?
    @FocusState private var editing: Bool

    private var conversation: RemoteConversation? {
        guard model.contextID == route.contextID,
              route.runID == nil || route.runID == model.state?.runId else { return nil }
        return model.state?.conversations.first { $0.id == route.conversationID }
    }

    var body: some View {
        Group {
            if let conversation, let state = model.state {
                transcript(conversation, state: state)
                    .safeAreaInset(edge: .bottom, spacing: 0) { composer(conversation, state: state) }
            } else {
                ContentUnavailableView(tr("conversationUnavailable"), systemImage: "bubble.left.and.exclamationmark.bubble.right", description: Text(tr("taskUnavailableHint")))
            }
        }
        .navigationTitle(tr("conversation"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .sheet(item: $newFolder, onDismiss: {
            if let route = startedConversation, model.contextID == route.contextID {
                openConversation(route)
            }
            startedConversation = nil
        }) { _ in
            NewConversationView { route in
                startedConversation = route
                newFolder = nil
            }
        }
        .confirmationDialog(tr("stopTurn"), isPresented: $showStop, titleVisibility: .visible, presenting: stopTarget) { target in
            Button(tr("stopTurn"), role: .destructive) {
                Task { await model.control(task: target.task, expectedContext: route.contextID, expectedRunID: target.runID) }
            }
        } message: { _ in Text(tr("stopExplanation")) }
    }

    private func transcript(_ conversation: RemoteConversation, state: RemoteState) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(conversation.first.requestTitle).font(.title3.weight(.semibold)).lineLimit(2).textSelection(.enabled)
                        Text(contextLabel(conversation, state: state)).font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = model.connectionError {
                        ErrorNote(text: error)
                        Text(tr("staleStateExplanation")).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error = model.actionError { ErrorNote(text: error) }
                    ForEach(conversation.turns) { task in
                        ConversationTurn(task: task, contextID: route.contextID, runID: state.runId)
                    }
                    if model.pending != nil { PendingSubmissionNotice(contextID: route.contextID).card() }
                    Color.clear.frame(height: 1).id("latestTurn")
                }.padding()
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onAppear { proxy.scrollTo("latestTurn", anchor: .bottom) }
            .onChange(of: conversation.turns.count) { _, _ in
                withAnimation { proxy.scrollTo("latestTurn", anchor: .bottom) }
            }
        }
    }

    private func contextLabel(_ conversation: RemoteConversation, state: RemoteState) -> String {
        let agent = state.backends.first { $0.id == conversation.first.backend }?.name ?? conversation.first.backend
        let project = state.projects.first { $0.id == conversation.first.project }?.name ?? conversation.first.project
        return [agent, model.selectedComputer?.displayName ?? "", project].joined(separator: " · ")
    }

    private func composer(_ conversation: RemoteConversation, state: RemoteState) -> some View {
        let binding = Binding<String>(
            get: { model.conversationDraft(conversationID: conversation.id, runID: state.runId) },
            set: { model.setConversationDraft($0, conversationID: conversation.id, runID: state.runId, expectedContext: route.contextID) }
        )
        let supported = state.capabilities?.conversationTurns == true
        let images = Binding(get: { model.images(conversationID: conversation.id, runID: state.runId) }, set: {
            model.setImages($0, expectedContext: route.contextID, conversationID: conversation.id, runID: state.runId)
        })
        let canSend = supported && conversation.canContinue && !model.busy && model.pending == nil &&
            model.connectionError == nil && !importingImage && (!binding.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.wrappedValue.isEmpty)
        let agent = state.backends.first { $0.id == conversation.first.backend }?.name ?? conversation.first.backend
        return VStack(alignment: .leading, spacing: 8) {
            WorkingFolderButton(project: state.projects.first { $0.id == conversation.first.project }) { project in
                if project.id != conversation.first.project { editing = false; newFolder = project }
            }
            Text(tr("conversationFolderHint")).font(.caption2).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                if !images.wrappedValue.isEmpty {
                    ImageAttachmentStrip(images: images.wrappedValue, store: model.imageStore,
                                         remove: model.busy || model.pending != nil ? nil : { image in images.wrappedValue.removeAll { $0.id == image.id } })
                }
                if !supported {
                    composerNotice(tr("updateGateway"))
                } else if conversation.latest.terminal && !conversation.canContinue {
                    composerNotice(tr("conversation_unavailable"))
                }
                TextField(tr("continuePrompt"), text: binding, axis: .vertical)
                    .font(.body).lineLimit(1...6).textFieldStyle(.plain).focused($editing)
                    .frame(minHeight: 44, alignment: .topLeading)
                    .padding(.horizontal, 4).padding(.top, 4)
                    .accessibilityIdentifier("conversationInput")
                    .accessibilityHint(tr(conversation.latest.terminal ? "sameConversationHint" : "draftWhileWorking"))
                HStack(spacing: 12) {
                    if state.capabilities?.imageAttachments == true {
                        ImageAttachmentPicker(images: images, importing: $importingImage, store: model.imageStore,
                            disabled: model.busy || model.pending != nil || state.backends.first(where: { $0.id == conversation.first.backend })?.imageInput == false)
                            .id(route.contextID.uuidString + state.runId + conversation.id)
                    }
                    Label(agent, systemImage: "terminal").font(.subheadline).foregroundStyle(.secondary)
                        .lineLimit(1).padding(.leading, 4)
                    if !conversation.latest.terminal { StatusBadge(status: conversation.latest.status) }
                    Spacer(minLength: 0)
                    if conversation.latest.terminal {
                        Button {
                            editing = false
                            Task { await model.submit(expectedContext: route.contextID, conversationID: conversation.id) }
                        } label: {
                            Image(systemName: "arrow.up").font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(canSend ? Color(uiColor: .systemBackground) : Color(uiColor: .tertiaryLabel))
                                .frame(width: 44, height: 44)
                                .background(canSend ? PersonalStyle.accent : Color(uiColor: .quaternarySystemFill), in: Circle())
                        }.buttonStyle(.plain).disabled(!canSend)
                            .accessibilityLabel(tr("sendMessage")).accessibilityIdentifier("sendFollowup")
                    } else {
                        Button(role: .destructive) {
                            editing = false
                            stopTarget = StopTarget(task: conversation.latest, runID: state.runId); showStop = true
                        } label: {
                            Image(systemName: "stop.fill").font(.system(size: 16, weight: .semibold))
                                .frame(width: 44, height: 44)
                                .background(Color(uiColor: .quaternarySystemFill), in: Circle())
                        }.buttonStyle(.plain)
                            .disabled(model.busy || model.connectionError != nil || conversation.latest.status == "cancelling")
                            .accessibilityLabel(tr(conversation.latest.status == "cancelling" ? "awaitingStop" : "stopTurn"))
                            .accessibilityIdentifier("stopTurn")
                    }
                }
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .strokeBorder(Color(uiColor: .separator).opacity(0.15), lineWidth: 0.5)
            }
            .shadow(color: .black.opacity(0.06), radius: 16, y: 4)
        }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
    }

    private func composerNotice(_ text: String) -> some View {
        Label(text, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4).padding(.top, 4)
    }
}

private struct ConversationTurn: View {
    @EnvironmentObject private var model: AppModel
    let task: RemoteTask
    let contextID: UUID
    let runID: String
    @State private var previewImage: ImageAttachment?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Spacer(minLength: 24)
                VStack(alignment: .leading, spacing: 8) {
                    if !task.request.isEmpty { Text(task.request).textSelection(.enabled) }
                    ForEach(task.attachments ?? []) { image in
                        Button { previewImage = image } label: { Label(image.name, systemImage: "photo") }
                            .frame(minHeight: 44).accessibilityIdentifier("sentImage-" + image.id)
                    }
                }.padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            }
            HStack {
                Label(model.state?.backends.first(where: { $0.id == task.backend })?.name ?? task.backend, systemImage: "terminal")
                    .font(.subheadline.weight(.medium))
                Spacer()
                StatusBadge(status: task.status)
            }
            if !task.output.isEmpty {
                Text(task.output).font(.body).textSelection(.enabled).accessibilityIdentifier("taskOutput")
                if task.outputTruncated { Text(tr("outputTruncated")).font(.caption).foregroundStyle(.secondary) }
            }
            if task.status == "failed", task.events.last?.text == "image_input_unsupported" {
                ErrorNote(text: tr("image_input_unsupported"))
            }
            if task.status == "failed", task.events.last?.text == "directory_changed" {
                ErrorNote(text: tr("directory_changed"))
            }
            ArtifactList(task: task, contextID: contextID, runID: runID)
            ForEach(task.permissions) { permission in
                VStack(alignment: .leading, spacing: 12) {
                    Label(tr("permissionTitle"), systemImage: "hand.raised.fill").font(.headline).foregroundStyle(.orange)
                    Text(permission.title).textSelection(.enabled)
                    if let command = permission.command { Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
                    if let input = permission.input { Text(input).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    if let cwd = permission.cwd { Label(cwd, systemImage: "folder").font(.caption).textSelection(.enabled) }
                    Text(tr(permission.canAllow ? "permissionScope" : "noOneTimeOption")).font(.footnote).foregroundStyle(.secondary)
                    ViewThatFits(in: .horizontal) {
                        HStack { permissionButtons(permission) }
                        VStack(alignment: .leading) { permissionButtons(permission) }
                    }.controlSize(.large).disabled(model.busy || model.connectionError != nil || task.status == "cancelling" || task.terminal)
                }.card()
            }
            DisclosureGroup(tr("activity")) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(task.events.suffix(12)) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.text).font(.footnote).textSelection(.enabled)
                            Text(Date(timeIntervalSince1970: event.at / 1000), style: .time).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            }.font(.footnote).tint(.secondary)
            Divider()
        }.accessibilityElement(children: .contain).accessibilityIdentifier("turn-\(task.id)")
            .sheet(item: $previewImage) { image in
                InputImagePreview(name: image.name) {
                    try await model.loadInputImage(image, taskID: task.id, expectedContext: contextID, runID: runID)
                }
            }
    }

    @ViewBuilder private func permissionButtons(_ permission: RemotePermission) -> some View {
        Button(tr("deny"), role: .destructive) { decide(permission, decision: "deny") }
            .buttonStyle(.bordered).accessibilityIdentifier("denyPermission")
        Button(tr("allowOnce")) { decide(permission, decision: "allow") }
            .buttonStyle(.borderedProminent).disabled(!permission.canAllow).accessibilityIdentifier("allowPermission")
    }

    private func decide(_ permission: RemotePermission, decision: String) {
        Task { await model.control(task: task, permission: permission, decision: decision, expectedContext: contextID, expectedRunID: runID) }
    }
}
