import SwiftUI

private struct FolderLocation: Hashable { let rootID: String; let path: String }
private struct FolderPickerRoute: Identifiable {
    let id = UUID()
    let contextID: UUID
    let runID: String
    let project: RemoteProject?
}

struct WorkingFolderButton: View {
    @EnvironmentObject private var model: AppModel
    let project: RemoteProject?
    var disabled = false
    var connectComputer: (() -> Void)? = nil
    var onSelected: ((RemoteProject) -> Void)? = nil
    @State private var route: FolderPickerRoute?
    @State private var picked: RemoteProject?
    @State private var owner: UUID?
    @State private var runID: String?

    var body: some View {
        Button {
            guard let state = model.state, model.connectionError == nil else { connectComputer?(); return }
            owner = model.contextID; runID = state.runId; picked = nil
            route = FolderPickerRoute(contextID: model.contextID, runID: state.runId, project: project)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "folder")
                VStack(alignment: .leading, spacing: 2) {
                    Text(project?.name ?? tr("chooseWorkingFolder")).font(.subheadline).lineLimit(1)
                    Text(project?.path ?? tr("workingFolderComputerHint")).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.caption)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(disabled || model.busy || model.pending != nil)
            .accessibilityLabel(tr("workingFolder")).accessibilityValue(project?.path ?? tr("chooseWorkingFolder"))
            .accessibilityIdentifier("workingFolderButton")
            .sheet(item: $route, onDismiss: {
                if let picked, model.contextID == owner, model.state?.runId == runID { onSelected?(picked) }
                picked = nil
            }) { route in
                WorkingFolderPicker(contextID: route.contextID, runID: route.runID, initialProject: route.project) { picked = $0 }
            }
    }
}

private struct WorkingFolderPicker: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let contextID: UUID
    let runID: String
    let onSelected: (RemoteProject) -> Void
    @State private var location: FolderLocation?
    @State private var listing: DirectoryListing?
    @State private var directories: [RemoteDirectory] = []
    @State private var loading = false
    @State private var selecting = false
    @State private var error: String?
    @State private var search = ""
    @State private var loadID: UUID?
    @State private var selectionTask: Task<Void, Never>?

    init(contextID: UUID, runID: String, initialProject: RemoteProject?, onSelected: @escaping (RemoteProject) -> Void) {
        self.contextID = contextID; self.runID = runID; self.onSelected = onSelected
        _location = State(initialValue: initialProject.map { FolderLocation(rootID: $0.rootId ?? $0.id, path: $0.relativePath ?? "") })
    }

    private var supported: Bool { model.state?.capabilities?.directorySelection == true }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(model.selectedComputer?.displayName ?? "", systemImage: "laptopcomputer")
                    Text(tr("sharedFoldersHint")).font(.footnote).foregroundStyle(.secondary)
                }
                if supported, let location {
                    Section {
                        Button { self.location = nil; search = "" } label: { Label(tr("sharedFolders"), systemImage: "rectangle.stack") }
                        if let listing {
                            Text(listing.path).font(.footnote).textSelection(.enabled).accessibilityIdentifier("browsedFolderPath")
                            if let parent = listing.parentPath {
                                Button { self.location = FolderLocation(rootID: location.rootID, path: parent); search = "" } label: {
                                    Label(tr("parentFolder"), systemImage: "arrow.up")
                                }.accessibilityIdentifier("parentFolder")
                            }
                        }
                    }
                    Section {
                        ForEach(directories.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { directory in
                            Button { self.location = FolderLocation(rootID: location.rootID, path: directory.relativePath); search = "" } label: {
                                Label(directory.name, systemImage: "folder")
                            }.accessibilityIdentifier("directory-" + directory.relativePath)
                        }
                        if loading { ProgressView(tr("loadingFolders")) }
                        else if listing != nil, directories.isEmpty { Text(tr("noSubfolders")).foregroundStyle(.secondary) }
                        if let cursor = listing?.nextCursor {
                            Button(tr("moreFolders")) { Task { await load(cursor: cursor) } }.disabled(loading)
                        }
                        if listing?.truncated == true { Text(tr("directoryListingLimited")).font(.footnote).foregroundStyle(.secondary) }
                    }
                    if let listing {
                        Section {
                            Button {
                                selectionTask = Task {
                                    selecting = true; defer { selecting = false }
                                    do {
                                        let project = try await model.chooseDirectory(rootID: listing.rootId, path: listing.relativePath, expectedContext: contextID, runID: runID, expectedPath: listing.path)
                                        try Task.checkCancellation(); onSelected(project); dismiss()
                                    } catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
                                }
                            } label: { Label(tr("useWorkingFolder"), systemImage: "checkmark.circle") }
                                .disabled(loading || selecting || model.busy || model.pending != nil).accessibilityIdentifier("useWorkingFolder")
                        }
                    }
                } else {
                    Section(tr("sharedFolders")) {
                        ForEach((supported ? model.state?.directoryRoots : model.state?.projects) ?? []) { project in
                            if search.isEmpty || project.name.localizedCaseInsensitiveContains(search) || project.path.localizedCaseInsensitiveContains(search) {
                                Button {
                                    if supported { location = FolderLocation(rootID: project.id, path: ""); search = "" }
                                    else if model.chooseProject(project, expectedContext: contextID, runID: runID) { onSelected(project); dismiss() }
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Label(project.name, systemImage: "folder")
                                        Text(project.path).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }.accessibilityIdentifier("sharedFolder-" + project.id)
                            }
                        }
                    }
                    if !supported { Text(tr("updateGatewayFolders")).font(.footnote).foregroundStyle(.secondary) }
                }
                if let error {
                    Section {
                        ErrorNote(text: error)
                        Button(tr("retryConnection")) { Task { await load() } }.disabled(loading)
                    }
                }
            }
            .navigationTitle(tr("workingFolder")).navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: tr("searchFolders"))
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(tr("cancel")) { dismiss() } } }
            .task(id: location) { await load() }
            .onChange(of: model.contextID) { _, value in if value != contextID { dismiss() } }
            .onChange(of: model.state?.runId) { _, value in if value != runID { dismiss() } }
            .onDisappear { loadID = nil; selectionTask?.cancel() }
        }
    }

    private func load(cursor: Int? = nil) async {
        guard supported, let location else { listing = nil; directories = []; error = nil; return }
        let id = UUID(); loadID = id; loading = true; error = nil
        if cursor == nil { listing = nil; directories = [] }
        defer { if loadID == id { loading = false } }
        do {
            let reply = try await model.listDirectories(rootID: location.rootID, path: location.path, cursor: cursor, expectedContext: contextID, runID: runID)
            try Task.checkCancellation()
            guard loadID == id, self.location == location else { return }
            let seen = Set(directories.map(\.id))
            directories += reply.directories.filter { !seen.contains($0.id) }; listing = reply
        } catch { if loadID == id, !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}
