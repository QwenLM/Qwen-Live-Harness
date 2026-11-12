import SwiftUI

private struct PollIdentity: Equatable {
    let contextID: UUID
    let isActive: Bool
}

@main
struct QwenLiveMobileApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            MainView().environmentObject(model).tint(Color(red: 0.12, green: 0.36, blue: 0.31))
                .task(id: PollIdentity(contextID: model.contextID, isActive: scenePhase == .active)) {
                    if scenePhase == .active { await model.poll() }
                }
        }
    }
}

struct MainView: View {
    @EnvironmentObject private var model: AppModel
    @State private var path: [TaskRoute] = []
    @State private var showComputers = false
    @State private var showPairing = false
    @State private var pairAfterListDismisses = false
    @State private var discard = false

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.connection == nil { PairingForm() }
                else { taskList }
            }
            .navigationTitle("Agent Remote")
            .navigationDestination(for: TaskRoute.self) { TaskDetail(route: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showComputers = true } label: { Label(tr("computers"), systemImage: "desktopcomputer") }
                        .accessibilityIdentifier("computersButton")
                }
                if model.connection != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(tr("refresh"), systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                    }
                }
            }
            .alert(tr("discardPending"), isPresented: $discard) {
                Button(tr("discard"), role: .destructive) { model.clearPending() }
                Button(tr("cancel"), role: .cancel) {}
            } message: { Text(tr("discardExplanation")) }
        }
        .onChange(of: model.contextID) { _, _ in path = []; discard = false }
        .onOpenURL { url in
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
                    .navigationTitle(tr("addComputer"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(tr("cancel")) { showPairing = false } } }
            }
        }
    }

    private var taskList: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.selectedComputer?.displayName ?? "").font(.headline).accessibilityIdentifier("activeComputerName")
                        Text(model.connectionError == nil && model.lastUpdated != nil ? tr("connected") : tr("reconnecting"))
                            .font(.caption).foregroundStyle(model.connectionError == nil ? .secondary : Color.orange)
                    }
                    Spacer()
                    Circle().fill(model.connectionError == nil && model.lastUpdated != nil ? Color.green : Color.orange).frame(width: 8, height: 8)
                }
                if let error = model.connectionError {
                    ErrorNote(text: error)
                    Button(tr("retryConnection")) { Task { await model.refresh() } }
                }
            } footer: { Text(tr("macKeepsWorking")) }

            if let state = model.state {
                Section(tr("newTask")) {
                    Picker(tr("agent"), selection: $model.backend) {
                        ForEach(state.backends) { backend in Text(backend.name).tag(backend.id) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("backendPicker")
                    Label(tr(state.permissionMode == "allow-all" ? "automaticPermissions" : "manualPermissions"), systemImage: state.permissionMode == "allow-all" ? "bolt.shield" : "hand.raised")
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker(tr("project"), selection: $model.project) {
                        ForEach(state.projects) { project in Text(project.name).tag(project.id) }
                    }
                    if let project = state.projects.first(where: { $0.id == model.project }) {
                        Text(project.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    if state.backends.first(where: { $0.id == model.backend })?.status == "starting" {
                        Label(tr("agentStarting"), systemImage: "hourglass").font(.footnote).foregroundStyle(.secondary)
                    }
                    ZStack(alignment: .topLeading) {
                        if model.draft.isEmpty { Text(tr("taskPlaceholder")).foregroundStyle(.tertiary).padding(.top, 8).allowsHitTesting(false) }
                        TextEditor(text: $model.draft).frame(minHeight: 110).scrollContentBackground(.hidden).accessibilityIdentifier("taskInput")
                    }
                    Button { let context = model.contextID; Task { await model.submit(expectedContext: context) } } label: {
                        HStack { Spacer(); if model.busy { ProgressView() } else { Label(tr("sendTask"), systemImage: "arrow.up.circle.fill") }; Spacer() }
                    }.buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy || model.pending != nil || model.backend.isEmpty || model.project.isEmpty || model.connectionError != nil)
                        .accessibilityIdentifier("sendTask")
                }
                if model.pending != nil {
                    Section {
                        Label(tr("pendingTitle"), systemImage: "exclamationmark.arrow.circlepath").font(.headline)
                        Text(tr("pendingExplanation")).font(.footnote).foregroundStyle(.secondary)
                        Button(tr("retrySameRequest")) { let context = model.contextID; Task { await model.submit(expectedContext: context) } }.disabled(model.busy)
                        Button(tr("discardPending"), role: .destructive) { discard = true }
                    }
                }
                if let error = model.actionError { Section { ErrorNote(text: error) } }
                Section(tr("tasks")) {
                    if state.tasks.isEmpty {
                        ContentUnavailableView(tr("noTasks"), systemImage: "checklist", description: Text(tr("noTasksHint")))
                    }
                    ForEach(state.tasks) { task in
                        NavigationLink(value: TaskRoute(contextID: model.contextID, taskID: task.id)) {
                            VStack(alignment: .leading, spacing: 9) {
                                HStack { Text(task.backend == "qwen" ? "Qwen Code" : "Codex").font(.caption.weight(.semibold)).foregroundStyle(.secondary); Spacer(); StatusBadge(status: task.status) }
                                Text(task.request).font(.body.weight(.medium)).lineLimit(2)
                                HStack {
                                    if !task.permissions.isEmpty { Label(tr("needsDecision"), systemImage: "hand.raised.fill").foregroundStyle(.orange) }
                                    Spacer()
                                    Text(Date(timeIntervalSince1970: task.updatedAt / 1000), style: .time).foregroundStyle(.secondary)
                                }.font(.caption)
                            }.padding(.vertical, 5)
                        }.accessibilityIdentifier("task-\(task.id)")
                    }
                }
            } else { Section { ProgressView(tr("loading")) } }
        }.refreshable { await model.refresh() }
    }
}

struct TaskDetail: View {
    @EnvironmentObject private var model: AppModel
    let route: TaskRoute
    @State private var stop = false
    private var task: RemoteTask? {
        guard model.contextID == route.contextID else { return nil }
        return model.state?.tasks.first { $0.id == route.taskID }
    }
    var body: some View {
        ScrollView {
            if let task {
                VStack(alignment: .leading, spacing: 20) {
                    HStack { Text(task.backend == "qwen" ? "Qwen Code" : "Codex").font(.headline); Spacer(); StatusBadge(status: task.status) }
                    Text(task.request).font(.title3.weight(.semibold)).textSelection(.enabled)
                    if let error = model.connectionError { ErrorNote(text: error) }
                    if let error = model.actionError { ErrorNote(text: error) }
                    ForEach(task.permissions) { permission in
                        VStack(alignment: .leading, spacing: 14) {
                            Label(tr("permissionTitle"), systemImage: "hand.raised.fill").font(.headline).foregroundStyle(.orange)
                            Text(permission.title).textSelection(.enabled)
                            if let command = permission.command { Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
                            if let input = permission.input { Text(input).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                            if let cwd = permission.cwd { Label(cwd, systemImage: "folder").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                            Text(tr(permission.canAllow ? "permissionScope" : "noOneTimeOption")).font(.footnote).foregroundStyle(.secondary)
                            HStack {
                                Button(tr("deny"), role: .destructive) { control(task: task, permission: permission, decision: "deny") }
                                    .buttonStyle(.bordered).accessibilityIdentifier("denyPermission")
                                Spacer()
                                Button(tr("allowOnce")) { control(task: task, permission: permission, decision: "allow") }
                                    .buttonStyle(.borderedProminent).disabled(!permission.canAllow).accessibilityIdentifier("allowPermission")
                            }.disabled(model.busy || model.connectionError != nil || task.status == "cancelling")
                        }.card()
                    }
                    if !task.output.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(tr(task.status == "completed" ? "result" : "agentOutput"), systemImage: "text.alignleft").font(.headline)
                            Text(task.output).font(.system(.callout, design: .monospaced)).textSelection(.enabled).accessibilityIdentifier("taskOutput")
                            if task.outputTruncated { Text(tr("outputTruncated")).font(.caption).foregroundStyle(.secondary) }
                        }.card()
                    }
                    VStack(alignment: .leading, spacing: 16) {
                        Label(tr("activity"), systemImage: "waveform.path").font(.headline)
                        ForEach(task.events.suffix(12)) { event in
                            HStack(alignment: .top, spacing: 12) {
                                Circle().fill(event.kind == "permission" ? Color.orange : Color.secondary.opacity(0.4)).frame(width: 6, height: 6).padding(.top, 6)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(event.text).font(.subheadline).textSelection(.enabled)
                                    Text(Date(timeIntervalSince1970: event.at / 1000), style: .time).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }.card()
                    if !task.terminal {
                        Button(tr(task.status == "cancelling" ? "awaitingStop" : "stopTask"), role: .destructive) { stop = true }
                            .buttonStyle(.bordered).frame(maxWidth: .infinity)
                            .disabled(model.busy || task.status == "cancelling" || model.connectionError != nil)
                    }
                }.padding(20).frame(maxWidth: 750)
            } else { ContentUnavailableView(tr("taskUnavailable"), systemImage: "clock.arrow.circlepath", description: Text(tr("taskUnavailableHint"))) }
        }.background(Color(uiColor: .systemGroupedBackground)).navigationTitle(tr("taskDetail")).navigationBarTitleDisplayMode(.inline)
            .alert(tr("stopTask"), isPresented: $stop) {
                Button(tr("stopTask"), role: .destructive) { if let task { control(task: task) } }
                Button(tr("cancel"), role: .cancel) {}
            } message: { Text(tr("stopExplanation")) }
    }

    private func control(task: RemoteTask, permission: RemotePermission? = nil, decision: String? = nil) {
        guard model.contextID == route.contextID, let runID = model.state?.runId else { return }
        Task { await model.control(task: task, permission: permission, decision: decision,
                                   expectedContext: route.contextID, expectedRunID: runID) }
    }
}

struct StatusBadge: View {
    let status: String
    private var color: Color {
        switch status { case "completed": return .green; case "waiting": return .orange; case "failed", "interrupted": return .red; case "cancelled": return .secondary; default: return .accentColor }
    }
    var body: some View { Text(tr(status)).font(.caption.weight(.semibold)).padding(.horizontal, 9).padding(.vertical, 5).foregroundStyle(color).background(color.opacity(0.10), in: Capsule()).accessibilityIdentifier("status-\(status)") }
}

struct ErrorNote: View {
    let text: String
    var body: some View { Label(text, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.red).textSelection(.enabled) }
}

extension View {
    func card() -> some View { self.frame(maxWidth: .infinity, alignment: .leading).padding(20).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20)) }
}
