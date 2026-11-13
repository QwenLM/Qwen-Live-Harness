import SwiftUI

struct WorkbenchView: View {
    @EnvironmentObject private var model: AppModel
    let showAssistant: () -> Void
    let showWorkbench: () -> Void
    @State private var path: [ConversationRoute] = []
    @State private var showComputers = false
    @State private var showPairing = false
    @State private var pairAfterListDismisses = false
    @State private var showNewConversation = false
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
            .navigationDestination(for: ConversationRoute.self) { ConversationDetail(route: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showComputers = true } label: { Label(tr("computers"), systemImage: "desktopcomputer") }
                        .accessibilityIdentifier("computersButton")
                }
                if model.connection != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showNewConversation = true } label: { Label(tr("newConversation"), systemImage: "square.and.pencil") }
                            .disabled(model.state == nil).accessibilityIdentifier("newConversation")
                    }
                }
            }
        }
        .onChange(of: model.contextID) { _, _ in path = []; showNewConversation = false; search = "" }
        .onOpenURL { url in
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
        .sheet(isPresented: $showNewConversation) {
            NewConversationView { route in
                showNewConversation = false
                if model.contextID == route.contextID { path.append(route) }
            }
        }
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
                Button(action: showAssistant) {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Text(tr("personalTeaser")).foregroundStyle(.primary); Spacer(); Text(tr("planned")).font(.caption).foregroundStyle(.secondary) }
                            Text(tr("personalTeaserDetail")).font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: { Image(systemName: "sparkles") }
                }
            }
            if model.pending != nil { Section { PendingSubmissionNotice(contextID: model.contextID) } }
            if let error = model.actionError { Section { ErrorNote(text: error) } }
            if let state = model.state {
                ForEach(state.projects) { project in
                    let items = conversations.filter { $0.first.project == project.id }
                    if !items.isEmpty {
                        Section {
                            ForEach(items) { conversation in
                                NavigationLink(value: ConversationRoute(contextID: model.contextID, conversationID: conversation.id)) {
                                    ConversationRow(conversation: conversation)
                                }.accessibilityIdentifier("task-\(conversation.id)")
                            }
                        } header: {
                            HStack {
                                Label(project.name, systemImage: "folder")
                                Spacer()
                                Button {
                                    model.project = project.id; showNewConversation = true
                                } label: { Image(systemName: "plus").frame(minWidth: 44, minHeight: 44) }
                                    .accessibilityLabel(tr("newConversation") + ": " + project.name)
                            }
                        }
                    }
                }
                if conversations.isEmpty {
                    ContentUnavailableView(search.isEmpty ? tr("noConversations") : tr("noSearchResults"), systemImage: "bubble.left.and.bubble.right", description: Text(tr("noConversationsHint")))
                }
                Section {
                    Button { showNewConversation = true } label: { Label(tr("newConversation"), systemImage: "plus.bubble") }
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
            Text(conversation.first.request).font(.body.weight(.medium)).lineLimit(2)
            HStack(alignment: .firstTextBaseline) {
                Text(model.state?.backends.first(where: { $0.id == conversation.first.backend })?.name ?? conversation.first.backend)
                    .foregroundStyle(.secondary)
                StatusBadge(status: conversation.latest.status)
                Spacer()
                Text(Date(timeIntervalSince1970: conversation.latest.updatedAt / 1000), style: .relative).foregroundStyle(.secondary)
            }.font(.caption)
            if !conversation.latest.permissions.isEmpty { Label(tr("needsDecision"), systemImage: "hand.raised.fill").font(.caption).foregroundStyle(.orange) }
        }.padding(.vertical, 4)
    }
}

struct NewConversationView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var editing: Bool
    let onStarted: (ConversationRoute) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(model.selectedComputer?.displayName ?? "", systemImage: "laptopcomputer")
                    if let state = model.state {
                        Picker(tr("project"), selection: $model.project) {
                            ForEach(state.projects) { Text($0.name).tag($0.id) }
                        }
                        if let project = state.projects.first(where: { $0.id == model.project }) {
                            Text(project.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Picker(tr("agent"), selection: $model.backend) {
                            ForEach(state.backends) { Text($0.name).tag($0.id) }
                        }.pickerStyle(.segmented).accessibilityIdentifier("backendPicker")
                        Label(tr(state.permissionMode == "allow-all" ? "automaticPermissions" : "manualPermissions"), systemImage: state.permissionMode == "allow-all" ? "bolt.shield" : "hand.raised")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextEditor(text: $model.draft).frame(minHeight: 150).focused($editing).accessibilityIdentifier("taskInput")
                } header: { Text(tr("request")) } footer: { Text(tr("newConversationHint")) }
                if model.pending != nil { Section { PendingSubmissionNotice(contextID: model.contextID) } }
                if let error = model.actionError { Section { ErrorNote(text: error) } }
                Section {
                    Button {
                        editing = false
                        let context = model.contextID
                        Task {
                            if let id = await model.submit(expectedContext: context), model.contextID == context {
                                onStarted(ConversationRoute(contextID: context, conversationID: id))
                            }
                        }
                    } label: {
                        HStack { Spacer(); if model.busy { ProgressView() } else { Text(tr("startConversation")) }; Spacer() }
                    }.disabled(model.busy || model.pending != nil || model.state == nil || model.connectionError != nil || model.backend.isEmpty || model.project.isEmpty || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("sendTask")
                }
            }
            .navigationTitle(tr("newConversation")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(tr("cancel")) { dismiss() } }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button(tr("done")) { editing = false } }
            }
        }
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
