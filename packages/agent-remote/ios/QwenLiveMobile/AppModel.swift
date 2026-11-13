import Foundation
import Combine
#if DEBUG
import Security
#endif

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var computers: [SavedComputer] = []
    @Published private(set) var selectedComputerID: UUID?
    @Published private(set) var contextID = UUID()
    @Published private(set) var state: RemoteState?
    @Published var pairingText = ""
    @Published private(set) var pairingTargetID: UUID?
    @Published var draft = "" { didSet { saveCurrentWorkspace() } }
    @Published var backend = "" { didSet { saveCurrentWorkspace() } }
    @Published var project = "" { didSet { saveCurrentWorkspace() } }
    @Published private(set) var busy = false
    @Published private(set) var connecting = false
    @Published private(set) var connectionError: String?
    @Published private(set) var actionError: String?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var pending: PendingSubmission?
    @Published private(set) var conversationDrafts: [String: String] = [:]
    var selectedComputer: SavedComputer? { computers.first { $0.id == selectedComputerID } }
    var connection: MacConnection? { selectedComputer?.connection }

    private let storage: any ConnectionPersistence
    private let defaults: UserDefaults
    private let makeAPI: (MacConnection) -> any RemoteAPI
    private var api: (any RemoteAPI)?
    private var workspaces: [String: ComputerWorkspace] = [:]
    private var restoring = false
    private var canSaveLibrary = false
    private var pairingOperation: UUID?
    private var actionOperation: UUID?
    private var requestSequence = 0
    private var appliedSequence = 0
    private let workspaceKey = "computerWorkspaces.v1"

    init(storage: any ConnectionPersistence = ConnectionStore(), defaults: UserDefaults = .standard,
         makeAPI: @escaping (MacConnection) -> any RemoteAPI = { MobileAPI($0) }) {
        self.storage = storage; self.defaults = defaults; self.makeAPI = makeAPI
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--uitesting") {
            // Only the simulator test launch resets credentials; normal launches
            // and physical devices always keep the existing Keychain records.
            for account in ["paired-mac", "paired-computers-v1"] {
                SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                               kSecAttrService as String: "com.qwenlive.mobile.connection",
                               kSecAttrAccount as String: account] as CFDictionary)
            }
            defaults.removeObject(forKey: workspaceKey)
            defaults.removeObject(forKey: "pendingSubmission")
        }
        #endif
        if let data = defaults.data(forKey: workspaceKey) {
            workspaces = (try? JSONDecoder().decode([String: ComputerWorkspace].self, from: data)) ?? [:]
        }
        do {
            let loaded = try storage.loadLibrary()
            var legacy: MacConnection?
            if loaded == nil || defaults.data(forKey: "pendingSubmission") != nil { legacy = try storage.loadLegacy() }
            var library = loaded ?? ConnectionLibrary(computers: [], selectedID: nil)
            if loaded == nil, let legacy {
                let computer = SavedComputer(id: UUID(), connection: legacy)
                library = ConnectionLibrary(computers: [computer], selectedID: computer.id)
            }
            try library.validate()
            canSaveLibrary = true
            computers = library.computers
            // Bind the old single-host pending request only to that host, never
            // to whichever computer happens to be selected in the new list.
            if let legacy, let data = defaults.data(forKey: "pendingSubmission"),
               let previous = try? JSONDecoder().decode(PendingSubmission.self, from: data),
               let owner = computers.first(where: { $0.connection == legacy }) {
                var workspace = workspaces[owner.id.uuidString] ?? ComputerWorkspace()
                if workspace.pending == nil { workspace.pending = previous }
                workspaces[owner.id.uuidString] = workspace
                if persistWorkspaces() { defaults.removeObject(forKey: "pendingSubmission") }
            }
            activate(library.selectedID ?? computers.first?.id)
            if loaded == nil, !computers.isEmpty {
                do { try storage.saveLibrary(currentLibrary()) }
                catch { actionError = tr("credentialSaveFailed") }
            }
        } catch { actionError = tr("credentialLoadFailed") }
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--uitesting") {
            pairingText = ProcessInfo.processInfo.environment["QWEN_LIVE_PAIRING"] ?? ""
        }
        #endif
    }

    private func currentLibrary(selected: UUID? = nil) -> ConnectionLibrary {
        ConnectionLibrary(computers: computers, selectedID: selected ?? selectedComputerID)
    }

    private func activate(_ id: UUID?) {
        cancelPairing()
        contextID = UUID(); selectedComputerID = id
        api = connection.map(makeAPI); state = nil; lastUpdated = nil
        connectionError = nil; actionError = nil; actionOperation = nil; busy = false
        let workspace = id.flatMap { workspaces[$0.uuidString] } ?? ComputerWorkspace()
        restoring = true
        draft = workspace.draft; backend = workspace.backend; project = workspace.project; pending = workspace.pending
        conversationDrafts = workspace.conversationDrafts ?? [:]
        restoring = false
    }

    @discardableResult
    func selectComputer(_ id: UUID) -> Bool {
        guard canSaveLibrary, computers.contains(where: { $0.id == id }) else { return false }
        if id == selectedComputerID { return true }
        do { try storage.saveLibrary(currentLibrary(selected: id)) }
        catch { actionError = tr("computerSaveFailed"); return false }
        activate(id)
        return true
    }

    func renameComputer(_ id: UUID, name: String) {
        let name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        guard canSaveLibrary, !name.isEmpty, let index = computers.firstIndex(where: { $0.id == id }) else { return }
        var next = computers; next[index].nickname = name
        do { try storage.saveLibrary(ConnectionLibrary(computers: next, selectedID: selectedComputerID)); computers = next }
        catch { actionError = tr("computerSaveFailed") }
    }

    func forgetComputer(_ id: UUID) {
        guard canSaveLibrary, computers.contains(where: { $0.id == id }) else { return }
        let next = computers.filter { $0.id != id }
        let selection = selectedComputerID == id ? next.first?.id : selectedComputerID
        do { try storage.saveLibrary(ConnectionLibrary(computers: next, selectedID: selection)) }
        catch { actionError = tr("computerSaveFailed"); return }
        if pairingTargetID == id { cancelPairing() }
        computers = next
        workspaces.removeValue(forKey: id.uuidString); persistWorkspaces()
        if selectedComputerID == id { activate(selection) }
    }

    func preparePairing(for computerID: UUID? = nil, link: String = "") {
        cancelPairing(); pairingTargetID = computerID; pairingText = link
        actionError = canSaveLibrary ? nil : tr("credentialLoadFailed")
    }

    func cancelPairing() {
        pairingOperation = nil; connecting = false; pairingTargetID = nil; pairingText = ""
    }

    @discardableResult
    func pair() async -> Bool {
        guard canSaveLibrary else { actionError = tr("credentialLoadFailed"); return false }
        guard !connecting else { return false }
        let operation = UUID(), originalContext = contextID, target = pairingTargetID
        pairingOperation = operation; connecting = true; actionError = nil
        defer { if pairingOperation == operation { pairingOperation = nil; connecting = false } }
        do {
            let pairing = try Pairing.parse(pairingText)
            let temporary = MacConnection(url: pairing.url, pin: pairing.pin, token: "", name: pairing.name)
            struct Reply: Decodable { let token: String; let runId: String }
            let reply: Reply = try await makeAPI(temporary).request("v1/pair", body: ["code": pairing.code], runId: nil)
            guard pairingOperation == operation, contextID == originalContext else { return false }
            let saved = MacConnection(url: pairing.url, pin: pairing.pin, token: reply.token, name: pairing.name)
            guard saved.isValid else { throw MobileFailure.invalidResponse }
            let existing = computers.firstIndex { $0.connection.pin == saved.pin }
                ?? target.flatMap { id in computers.firstIndex { $0.id == id } }
            var next = computers
            let selectedID: UUID
            if let existing { next[existing].connection = saved; selectedID = next[existing].id }
            else { let computer = SavedComputer(id: UUID(), connection: saved); next.append(computer); selectedID = computer.id }
            var warning: String?
            do { try storage.saveLibrary(ConnectionLibrary(computers: next, selectedID: selectedID)) }
            catch { warning = tr("credentialSaveFailed") }
            computers = next; activate(selectedID); actionError = warning
            await refresh()
            return true
        } catch {
            if pairingOperation == operation, contextID == originalContext { actionError = error.localizedDescription }
            return false
        }
    }

    func refresh(expectedContext: UUID? = nil) async {
        guard expectedContext == nil || expectedContext == contextID, let api else { return }
        let current = contextID
        requestSequence += 1; let sequence = requestSequence
        do {
            let next: RemoteState = try await api.request("v1/state")
            guard contextID == current, sequence > appliedSequence, next.version == 1 else { return }
            appliedSequence = sequence; state = next; connectionError = nil; lastUpdated = Date()
            if !next.backends.contains(where: { $0.id == backend }) { backend = next.backends.first?.id ?? "" }
            if !next.projects.contains(where: { $0.id == project }) { project = next.projects.first?.id ?? "" }
            if let pending, next.runId == pending.runId,
               next.tasks.contains(where: { matches($0, submission: pending) }),
               let owner = selectedComputerID { acknowledge(pending, owner: owner) }
        } catch {
            if !Task.isCancelled, contextID == current, sequence > appliedSequence { connectionError = error.localizedDescription }
        }
    }

    func poll() async {
        guard connection != nil else { return }
        let current = contextID
        while !Task.isCancelled, contextID == current {
            await refresh(expectedContext: current)
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    @discardableResult
    func submit(expectedContext: UUID, conversationID: String? = nil) async -> String? {
        guard contextID == expectedContext, !busy, let api, let state, let owner = selectedComputerID else { return nil }
        let submission: PendingSubmission
        if let pending {
            guard pending.conversationId == conversationID else { actionError = tr("pendingTitle"); return nil }
            guard pending.runId == state.runId else { actionError = tr("server_restarted"); return nil }
            submission = pending
        } else if let conversationID {
            guard state.capabilities?.conversationTurns == true else { actionError = tr("updateGateway"); return nil }
            guard let conversation = state.conversations.first(where: { $0.id == conversationID }), conversation.canContinue else {
                actionError = tr("conversation_unavailable"); return nil
            }
            submission = PendingSubmission(id: UUID().uuidString.lowercased(), backend: conversation.first.backend,
                project: conversation.first.project, text: conversationDraft(conversationID: conversationID, runID: state.runId).trimmingCharacters(in: .whitespacesAndNewlines),
                runId: state.runId, conversationId: conversationID)
        } else {
            guard state.backends.contains(where: { $0.id == backend }), state.projects.contains(where: { $0.id == project }) else { return nil }
            submission = PendingSubmission(id: UUID().uuidString.lowercased(), backend: backend, project: project,
                text: draft.trimmingCharacters(in: .whitespacesAndNewlines), runId: state.runId)
        }
        guard !submission.text.isEmpty else { return nil }
        pending = submission
        guard saveCurrentWorkspace() else { actionError = tr("pendingSaveFailed"); return nil }
        let operation = UUID(); actionOperation = operation; busy = true; actionError = nil
        defer { if actionOperation == operation { busy = false; actionOperation = nil } }
        do {
            var body = ["id": submission.id, "backend": submission.backend, "project": submission.project, "text": submission.text]
            if let conversationID = submission.conversationId { body["conversationId"] = conversationID }
            let receipt: RemoteTask = try await api.request("v1/tasks", body: body, runId: submission.runId)
            guard matches(receipt, submission: submission) else { throw MobileFailure.invalidResponse }
            acknowledge(submission, owner: owner)
            if contextID == expectedContext { await refresh(expectedContext: expectedContext) }
            return submission.conversationId ?? submission.id
        } catch {
            if contextID == expectedContext { actionError = error.localizedDescription; await refresh(expectedContext: expectedContext) }
            return nil
        }
    }

    private func matches(_ task: RemoteTask, submission: PendingSubmission) -> Bool {
        task.id == submission.id && task.backend == submission.backend && task.project == submission.project && task.request == submission.text &&
        (task.conversationId ?? task.id) == (submission.conversationId ?? submission.id)
    }

    func conversationDraft(conversationID: String, runID: String) -> String {
        conversationDrafts[runID + ":" + conversationID] ?? ""
    }

    func setConversationDraft(_ text: String, conversationID: String, runID: String, expectedContext: UUID) {
        guard contextID == expectedContext, state?.runId == runID else { return }
        conversationDrafts[runID + ":" + conversationID] = text
        saveCurrentWorkspace()
    }

    func retryPending(expectedContext: UUID) async {
        guard let pending else { return }
        await submit(expectedContext: expectedContext, conversationID: pending.conversationId)
    }

    private func acknowledge(_ submission: PendingSubmission, owner: UUID) {
        guard var workspace = workspaces[owner.uuidString], workspace.pending?.id == submission.id else { return }
        workspace.pending = nil
        if let conversationID = submission.conversationId {
            let key = submission.runId + ":" + conversationID
            if workspace.conversationDrafts?[key]?.trimmingCharacters(in: .whitespacesAndNewlines) == submission.text {
                workspace.conversationDrafts?.removeValue(forKey: key)
            }
        } else if workspace.draft.trimmingCharacters(in: .whitespacesAndNewlines) == submission.text { workspace.draft = "" }
        workspaces[owner.uuidString] = workspace; persistWorkspaces()
        if owner == selectedComputerID {
            restoring = true; pending = nil; draft = workspace.draft; conversationDrafts = workspace.conversationDrafts ?? [:]; restoring = false
        }
    }

    func clearPending() { pending = nil; saveCurrentWorkspace() }

    func loadArtifact(_ artifact: RemoteArtifact, taskID: String, expectedContext: UUID, runID: String) async throws -> Data {
        guard contextID == expectedContext, let api, state?.runId == runID,
              UUID(uuidString: taskID) != nil, UUID(uuidString: artifact.id) != nil,
              (1...8 * 1024 * 1024).contains(artifact.size),
              state?.tasks.first(where: { $0.id == taskID })?.artifacts?.contains(artifact) == true else {
            throw MobileFailure.remote(409, "artifact_unavailable")
        }
        let content: ArtifactContent = try await api.request("v1/tasks/\(taskID)/artifacts/\(artifact.id)", body: nil, runId: runID)
        try Task.checkCancellation()
        guard contextID == expectedContext, state?.runId == runID else { throw CancellationError() }
        guard content.id == artifact.id, content.taskId == taskID, content.runId == runID,
              content.mimeType == artifact.mimeType, content.data.utf8.count <= 12 * 1024 * 1024,
              let data = Data(base64Encoded: content.data), data.count == artifact.size else { throw MobileFailure.invalidResponse }
        return data
    }

    func control(task: RemoteTask, permission: RemotePermission? = nil, decision: String? = nil,
                 expectedContext: UUID, expectedRunID: String) async {
        guard contextID == expectedContext, !busy, let api, let state, state.runId == expectedRunID,
              state.tasks.contains(where: { $0.id == task.id && $0.backend == task.backend && $0.project == task.project }) else { return }
        let operation = UUID(); actionOperation = operation; busy = true; actionError = nil
        defer { if actionOperation == operation { busy = false; actionOperation = nil } }
        do {
            let path = "v1/tasks/\(task.id)/" + (permission == nil ? "cancel" : "permission")
            let body = permission.map { ["requestId": $0.id, "decision": decision ?? "deny"] } ?? [:]
            let _: RemoteTask = try await api.request(path, body: body, runId: expectedRunID)
            if contextID == expectedContext { await refresh(expectedContext: expectedContext) }
        } catch { if contextID == expectedContext { actionError = error.localizedDescription } }
    }

    @discardableResult
    private func saveCurrentWorkspace() -> Bool {
        guard !restoring, let id = selectedComputerID else { return true }
        workspaces[id.uuidString] = ComputerWorkspace(draft: draft, backend: backend, project: project, pending: pending, conversationDrafts: conversationDrafts)
        return persistWorkspaces()
    }

    @discardableResult
    private func persistWorkspaces() -> Bool {
        do { defaults.set(try JSONEncoder().encode(workspaces), forKey: workspaceKey); return true }
        catch { return false }
    }
}
