import SwiftUI

private enum WorkbenchPage: Hashable {
    case newConversation(context: UUID, id: UUID)
    case conversation(ConversationRoute)
}

struct WorkbenchView: View {
    @EnvironmentObject private var model: AppModel
    let showWorkbench: () -> Void
    @Binding var requestedRoute: ConversationRoute?
    @Binding var requestedPairingURL: URL?
    @State private var path: [WorkbenchPage] = []
    @State private var showComputers = false
    @State private var showPairing = false
    @State private var pairAfterListDismisses = false
    @State private var search = ""

    private var conversations: [RemoteConversation] {
        (model.state?.conversations ?? []).filter { conversation in
            search.isEmpty || conversation.first.request.localizedCaseInsensitiveContains(search) ||
            (model.state?.projects.first(where: { $0.id == conversation.first.project })?.name.localizedCaseInsensitiveContains(search) == true)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.connection == nil { PairingForm() }
                else { workbench }
            }
            .navigationTitle(tr("workbench"))
            .navigationDestination(for: WorkbenchPage.self) { page in
                switch page {
                case .newConversation(let context, _):
                    NewConversationView(contextID: context, openDraft: openDraft)
                case .conversation(let route):
                    ConversationDetail(route: route, openDraft: openDraft)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showComputers = true } label: { Label(tr("computers"), systemImage: "desktopcomputer") }
                        .accessibilityIdentifier("computersButton")
                }
                if model.connection != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                    Button(action: openDraft) { Label(tr("newConversation"), systemImage: "square.and.pencil") }
                            .disabled(model.state == nil).accessibilityIdentifier("newConversation")
                    }
                }
            }
        }
        .onChange(of: model.contextID) { _, _ in path = []; search = "" }
        .onChange(of: requestedRoute, initial: true) { _, route in
            guard let route else { return }
            requestedRoute = nil
            guard route.contextID == model.contextID, route.runID == model.state?.runId,
                  model.state?.conversations.contains(where: { $0.id == route.conversationID }) == true else { return }
            if path.last != .conversation(route) { path.append(.conversation(route)) }
        }
        .onChange(of: requestedPairingURL, initial: true) { _, url in
            guard let url else { return }
            requestedPairingURL = nil
            showWorkbench()
            model.preparePairing(link: url.absoluteString)
            if showComputers { pairAfterListDismisses = true; showComputers = false }
            else if model.connection != nil { showPairing = true }
        }
        .sheet(isPresented: $showComputers, onDismiss: {
            if pairAfterListDismisses { pairAfterListDismisses = false; showPairing = true }
        }) {
            ComputersView { id in
                model.preparePairing(for: id)
                pairAfterListDismisses = true; showComputers = false
            }
        }
        .sheet(isPresented: $showPairing, onDismiss: { model.cancelPairing() }) {
            NavigationStack {
                PairingForm { showPairing = false }
                    .navigationTitle(tr("addComputer")).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(tr("cancel")) { showPairing = false } } }
            }
        }
    }

    private func openDraft() {
        path.append(.newConversation(context: model.contextID, id: UUID()))
    }

    private var workbench: some View {
        List {
            Section {
                Button { showComputers = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "laptopcomputer").foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.selectedComputer?.displayName ?? "").font(.headline).foregroundStyle(.primary)
                                .accessibilityIdentifier("activeComputerName")
                            Text(tr(model.connectionError == nil && model.lastUpdated != nil ? "connected" : "reconnecting"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
                if let error = model.connectionError {
                    ErrorNote(text: error)
                    Button(tr("retryConnection")) { Task { await model.refresh() } }
                    Text(tr("staleStateExplanation")).font(.footnote).foregroundStyle(.secondary)
                }
            } footer: { Text(tr("macKeepsWorking")) }
            Section {
                Button(action: openDraft) { Label(tr("newConversation"), systemImage: "plus.bubble") }
                    .disabled(model.state == nil).accessibilityIdentifier("newConversationCard")
            }
            if model.pending != nil { Section { PendingSubmissionNotice(contextID: model.contextID) } }
            if let error = model.actionError { Section { ErrorNote(text: error) } }
            if let state = model.state {
                ForEach(state.projects) { project in
                    let items = conversations.filter { $0.first.project == project.id }
                    if !items.isEmpty {
                        Section {
                            ForEach(items) { conversation in
                                NavigationLink(value: WorkbenchPage.conversation(ConversationRoute(contextID: model.contextID, conversationID: conversation.id, runID: state.runId))) {
                                    ConversationRow(conversation: conversation)
                                }.accessibilityIdentifier("task-\(conversation.id)")
                            }
                        } header: {
                            HStack {
                                Label(project.name, systemImage: "folder")
                                Spacer()
                                Button {
                                    if model.chooseProject(project, expectedContext: model.contextID, runID: state.runId) { openDraft() }
                                } label: { Image(systemName: "plus").frame(minWidth: 44, minHeight: 44) }
                                    .disabled(model.busy || model.pending != nil)
                                    .accessibilityIdentifier("newConversation-" + project.id)
                                    .accessibilityLabel(tr("newConversation") + ": " + project.name)
                            }
                        }
                    }
                }
                if conversations.isEmpty {
                    ContentUnavailableView(search.isEmpty ? tr("noConversations") : tr("noSearchResults"), systemImage: "bubble.left.and.bubble.right", description: Text(tr("noConversationsHint")))
                }
            } else { Section { ProgressView(tr("loading")) } }
        }
        .searchable(text: $search, prompt: tr("searchConversations"))
        .refreshable { await model.refresh() }
    }
}

private struct ConversationRow: View {
    @EnvironmentObject private var model: AppModel
    let conversation: RemoteConversation
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(conversation.first.requestTitle).font(.body.weight(.medium)).lineLimit(2)
            HStack(alignment: .firstTextBaseline) {
                Text(model.state?.backends.first(where: { $0.id == conversation.first.backend })?.name ?? conversation.first.backend)
                    .foregroundStyle(.secondary)
                StatusBadge(status: conversation.latest.status)
                Spacer()
                TaskElapsedTime(task: conversation.latest).foregroundStyle(.secondary)
            }.font(.caption)
            if !conversation.latest.permissions.isEmpty { Label(tr("needsDecision"), systemImage: "hand.raised.fill").font(.caption).foregroundStyle(.orange) }
        }.padding(.vertical, 4)
    }
}

struct TaskElapsedTime: View {
    let task: RemoteTask
    var body: some View {
        Group {
            if task.terminal { label(at: Date()) }
            else { TimelineView(.periodic(from: .now, by: 1)) { label(at: $0.date) } }
        }.monospacedDigit().accessibilityIdentifier("elapsed-\(task.id)")
            .accessibilityLabel(tr("runDuration"))
    }
    private func label(at date: Date) -> some View {
        let value = Duration.seconds(task.elapsed(at: date)).formatted(.time(pattern: .hourMinuteSecond(padHourToLength: 1)))
        return Text(value).accessibilityValue(value)
    }
}

struct PendingSubmissionNotice: View {
    @EnvironmentObject private var model: AppModel
    let contextID: UUID
    @State private var discard = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(tr("pendingTitle"), systemImage: "exclamationmark.arrow.circlepath").font(.headline)
            Text(tr("pendingExplanation")).font(.footnote).foregroundStyle(.secondary)
            Button(tr("retrySameRequest")) { Task { await model.retryPending(expectedContext: contextID) } }.disabled(model.busy)
            Button(tr("discardPending"), role: .destructive) { discard = true }
        }
        .confirmationDialog(tr("discardPending"), isPresented: $discard, titleVisibility: .visible) {
            Button(tr("discard"), role: .destructive) { if model.contextID == contextID { model.clearPending() } }
        } message: { Text(tr("discardExplanation")) }
    }
}
