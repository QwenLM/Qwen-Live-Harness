import SwiftUI

struct ConversationDetail: View {
    @EnvironmentObject private var model: AppModel
    let route: ConversationRoute
    let openDraft: () -> Void
    private struct StopTarget { let task: RemoteTask; let runID: String }
    @State private var stopTarget: StopTarget?
    @State private var showStop = false
    @State private var importingImage = false
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
                    .bottomComposer { composer(conversation, state: state) }
            } else {
                ContentUnavailableView(tr("conversationUnavailable"), systemImage: "bubble.left.and.exclamationmark.bubble.right", description: Text(tr("taskUnavailableHint")))
            }
        }
        .navigationTitle(tr("conversation"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
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
            HStack(spacing: 12) {
                WorkingFolderButton(project: state.projects.first { $0.id == conversation.first.project }, onSelected: { project in
                    if project.id != conversation.first.project { editing = false; openDraft() }
                })
                Label(agent, systemImage: "terminal").font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
            Text(tr("conversationFolderHint")).font(.caption2).foregroundStyle(.secondary)
            if !images.wrappedValue.isEmpty {
                ImageAttachmentStrip(images: images.wrappedValue, store: model.imageStore,
                                     remove: model.busy || model.pending != nil ? nil : { image in images.wrappedValue.removeAll { $0.id == image.id } })
            }
            if !supported {
                composerNotice(tr("updateGateway"))
            } else if conversation.latest.terminal && !conversation.canContinue {
                composerNotice(tr("conversation_unavailable"))
            }
            if !conversation.latest.terminal { StatusBadge(status: conversation.latest.status) }
            ComposerBar {
                if state.capabilities?.imageAttachments == true {
                    ImageAttachmentPicker(images: images, importing: $importingImage, store: model.imageStore,
                        disabled: model.busy || model.pending != nil || state.backends.first(where: { $0.id == conversation.first.backend })?.imageInput == false)
                        .id(route.contextID.uuidString + state.runId + conversation.id)
                }
            } field: {
                TextField(tr("continuePrompt"), text: binding, axis: .vertical)
                    .focused($editing)
                    .accessibilityIdentifier("conversationInput")
                    .accessibilityHint(tr(conversation.latest.terminal ? "sameConversationHint" : "draftWhileWorking"))
            } actions: {
                if conversation.latest.terminal {
                    Button {
                        editing = false
                        Task { await model.submit(expectedContext: route.contextID, conversationID: conversation.id) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title).frame(width: 44, height: 44)
                    }.disabled(!canSend)
                        .accessibilityLabel(tr("sendMessage")).accessibilityIdentifier("sendFollowup")
                } else {
                    Button(role: .destructive) {
                        editing = false
                        stopTarget = StopTarget(task: conversation.latest, runID: state.runId); showStop = true
                    } label: {
                        Image(systemName: "stop.circle.fill").font(.title).frame(width: 44, height: 44)
                    }.disabled(model.busy || model.connectionError != nil || conversation.latest.status == "cancelling")
                        .accessibilityLabel(tr(conversation.latest.status == "cancelling" ? "awaitingStop" : "stopTurn"))
                        .accessibilityIdentifier("stopTurn")
                }
            }
        }
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
                VStack(alignment: .leading, spacing: 10) {
                    MarkdownContent(text: task.output)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("taskOutput")
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
