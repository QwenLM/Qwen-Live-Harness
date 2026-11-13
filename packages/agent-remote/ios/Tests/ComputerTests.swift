import XCTest
import Security
@testable import QwenLiveMobile

private final class MemoryConnections: ConnectionPersistence {
    var library: ConnectionLibrary?
    var legacy: MacConnection?
    var failRead = false
    var failSave = false
    var writes = 0
    func loadLibrary() throws -> ConnectionLibrary? {
        if failRead { throw MobileFailure.invalidResponse }
        return library
    }
    func loadLegacy() throws -> MacConnection? { legacy }
    func saveLibrary(_ value: ConnectionLibrary) throws {
        if failSave { throw MobileFailure.invalidResponse }
        try value.validate(); library = value; writes += 1
    }
}

private final class StubAPI: RemoteAPI {
    struct Call { let path: String; let body: [String: String]?; let runID: String? }
    var calls: [Call] = []
    var handle: (String, [String: String]?, String?) async throws -> Data
    init(_ handle: @escaping (String, [String: String]?, String?) async throws -> Data) { self.handle = handle }
    func request<T: Decodable>(_ path: String, body: [String: String]?, runId: String?) async throws -> T {
        calls.append(Call(path: path, body: body, runID: runId))
        return try JSONDecoder().decode(T.self, from: await handle(path, body, runId))
    }
}

private final class ReplyGate {
    var waiting = false
    private var reply: CheckedContinuation<Data, Never>?
    func wait() async -> Data {
        await withCheckedContinuation { reply = $0; waiting = true }
    }
    func resolve(_ data: Data) { reply?.resume(returning: data); reply = nil }
}

@MainActor
final class ComputerTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "agent-remote-computers-tests-" + UUID().uuidString
        addTeardownBlock { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        return UserDefaults(suiteName: name)!
    }
    private func computer(_ letter: String) -> SavedComputer {
        SavedComputer(id: UUID(), connection: MacConnection(url: "https://\(letter).local:47421", pin: String(repeating: letter, count: 64), token: String(repeating: letter, count: 43), name: "Computer \(letter)"))
    }
    private func store(_ computers: [SavedComputer], selected: UUID? = nil) -> MemoryConnections {
        let storage = MemoryConnections()
        storage.library = ConnectionLibrary(computers: computers, selectedID: selected ?? computers.first?.id)
        return storage
    }
    private func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    private func state(_ name: String, run: String = "same-run", tasks: [[String: Any]] = [], continuations: Bool? = nil) throws -> Data {
        var value: [String: Any] = ["version": 1, "runId": run, "permissionMode": "allow-all", "backends": [["id": "qwen", "name": "Qwen Code", "status": "ready"], ["id": "codex", "name": "Codex", "status": "ready"]], "projects": [["id": "shared-project", "name": name, "path": "/fixture/\(name)"]], "tasks": tasks]
        if let continuations { value["capabilities"] = ["conversationTurns": continuations] }
        return try json(value)
    }
    private func task(_ text: String, id: String = "same-task") -> [String: Any] {
        ["id": id, "backend": "qwen", "project": "shared-project", "request": text, "status": "running", "createdAt": 1, "updatedAt": 1, "activity": "", "output": "", "outputTruncated": false, "permissions": [], "events": []]
    }
    private func pairing(_ computer: SavedComputer) throws -> String {
        let payload = try json(["version": 1, "url": computer.connection.url, "pin": computer.connection.pin, "code": String(repeating: "c", count: 43), "name": computer.connection.name])
        return "qwenliveharness://pair?data=" + payload.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        XCTFail("Fixture request did not start")
    }

    func testKeychainMigrationKeepsOriginalCredentialAndDoesNotResurrectForgottenComputer() async throws {
        let original = computer("a")
        let service = "com.agentremote.tests." + UUID().uuidString
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary) }
        let status = SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: "paired-mac", kSecValueData as String: try JSONEncoder().encode(original.connection),
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
        XCTAssertEqual(status, errSecSuccess)
        let storage = ConnectionStore(service: service), preferences = defaults()
        let model = AppModel(storage: storage, defaults: preferences)
        XCTAssertEqual(model.computers.count, 1)
        XCTAssertEqual(model.connection, original.connection)
        XCTAssertNil(try storage.loadLegacy(), "The durable library replaces the obsolete single-host record")
        XCTAssertEqual(try storage.loadLibrary()?.computers.first?.connection, original.connection)
        model.forgetComputer(try XCTUnwrap(model.selectedComputerID))
        let reopened = AppModel(storage: storage, defaults: preferences)
        XCTAssertTrue(reopened.computers.isEmpty)
        XCTAssertNil(reopened.connection)
    }

    func testArtifactReadsUseOnlyTheOwnedTurnAndRejectMismatchedResponses() async throws {
        let a = computer("a"), taskID = UUID().uuidString.lowercased(), artifactID = UUID().uuidString.lowercased()
        let text = "# Preview", encoded = Data("# Preview".utf8).base64EncodedString()
        var item = task("work", id: taskID)
        let metadata: [String: Any] = ["id": artifactID, "name": "report.md", "mimeType": "text/markdown", "kind": "markdown", "size": text.utf8.count]
        item["artifacts"] = [metadata]; item["status"] = "completed"
        var responseID = artifactID
        let api = StubAPI { path, _, _ in
            if path == "v1/state" { return try self.state("a", tasks: [item]) }
            return try self.json(["id": responseID, "taskId": taskID, "runId": "same-run", "mimeType": "text/markdown", "data": encoded])
        }
        let model = AppModel(storage: store([a]), defaults: defaults(), makeAPI: { _ in api })
        await model.refresh()
        let artifact = try XCTUnwrap(model.state?.tasks.first?.artifacts?.first)
        let content = try await model.loadArtifact(artifact, taskID: taskID, expectedContext: model.contextID, runID: "same-run")
        XCTAssertEqual(String(data: content, encoding: .utf8), text)
        XCTAssertEqual(api.calls.last?.path, "v1/tasks/\(taskID)/artifacts/\(artifactID)")
        XCTAssertEqual(api.calls.last?.runID, "same-run"); XCTAssertNil(api.calls.last?.body)
        responseID = UUID().uuidString.lowercased()
        do { _ = try await model.loadArtifact(artifact, taskID: taskID, expectedContext: model.contextID, runID: "same-run"); XCTFail("Mismatched artifact must not display") }
        catch MobileFailure.invalidResponse { }
        let count = api.calls.count
        do { _ = try await model.loadArtifact(artifact, taskID: UUID().uuidString, expectedContext: model.contextID, runID: "same-run"); XCTFail("Unknown turn must not be requested") }
        catch { }
        XCTAssertEqual(api.calls.count, count)
    }

    func testLateArtifactReadCannotCrossComputerSelectionsOrServerRuns() async throws {
        for switchComputer in [true, false] {
            let a = computer("a"), b = computer("b"), gate = ReplyGate()
            let taskID = UUID().uuidString.lowercased(), artifactID = UUID().uuidString.lowercased()
            var item = task("work", id: taskID)
            item["artifacts"] = [["id": artifactID, "name": "report.md", "mimeType": "text/markdown", "kind": "markdown", "size": 2]]
            var run = "same-run"
            let api = StubAPI { path, _, _ in
                if path == "v1/state" { return try self.state("a", run: run, tasks: [item]) }
                return await gate.wait()
            }
            let apiB = StubAPI { _, _, _ in try self.state("b") }
            let model = AppModel(storage: store([a, b]), defaults: defaults(), makeAPI: { $0.pin == a.connection.pin ? api : apiB })
            await model.refresh()
            let artifact = try XCTUnwrap(model.state?.tasks.first?.artifacts?.first), context = model.contextID
            let loading = Task { try await model.loadArtifact(artifact, taskID: taskID, expectedContext: context, runID: "same-run") }
            await waitFor { gate.waiting }
            if switchComputer { XCTAssertTrue(model.selectComputer(b.id)) } else { run = "restarted-run" }
            await model.refresh()
            gate.resolve(try json(["id": artifactID, "taskId": taskID, "runId": "same-run", "mimeType": "text/markdown", "data": Data("ok".utf8).base64EncodedString()]))
            do { _ = try await loading.value; XCTFail("Old preview must not be displayed") }
            catch is CancellationError { }
            XCTAssertEqual(model.state?.projects.first?.name, switchComputer ? "b" : "a")
        }
    }

    func testPairTwoComputersSwitchAndRestoreWithoutPairingAgain() async throws {
        let a = computer("a"), b = computer("b"), storage = store([]), preferences = defaults()
        let apiA = StubAPI { path, _, _ in path == "v1/pair" ? try self.json(["token": a.connection.token, "runId": "a-run"]) : try self.state("a") }
        let apiB = StubAPI { path, _, _ in path == "v1/pair" ? try self.json(["token": b.connection.token, "runId": "b-run"]) : try self.state("b") }
        let factory: (MacConnection) -> any RemoteAPI = { $0.pin == a.connection.pin ? apiA : apiB }
        let model = AppModel(storage: storage, defaults: preferences, makeAPI: factory)
        model.preparePairing(link: try pairing(a)); let pairedA = await model.pair(); XCTAssertTrue(pairedA)
        model.preparePairing(link: try pairing(b)); let pairedB = await model.pair(); XCTAssertTrue(pairedB)
        XCTAssertEqual(model.computers.count, 2)
        let idA = try XCTUnwrap(model.computers.first { $0.connection.pin == a.connection.pin }?.id)
        XCTAssertTrue(model.selectComputer(idA)); await model.refresh()
        XCTAssertEqual(model.state?.projects.first?.name, "a")
        let reopened = AppModel(storage: storage, defaults: preferences, makeAPI: factory)
        XCTAssertEqual(reopened.selectedComputerID, idA)
        XCTAssertEqual(reopened.computers.count, 2)
        XCTAssertEqual(apiA.calls.filter { $0.path == "v1/pair" }.count, 1)
        XCTAssertEqual(apiB.calls.filter { $0.path == "v1/pair" }.count, 1)
    }

    func testEachComputerKeepsItsOwnDraftAgentAndUnconfirmedSubmission() async throws {
        let a = computer("a"), b = computer("b"), preferences = defaults(), storage = store([computer("c")])
        storage.library = ConnectionLibrary(computers: [a, b], selectedID: a.id)
        let api = StubAPI { path, _, _ in
            if path == "v1/tasks" { throw URLError(.networkConnectionLost) }
            return try self.state("fixture")
        }
        let model = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        await model.refresh(); model.draft = "only on A"; model.backend = "codex"
        await model.submit(expectedContext: model.contextID)
        let requestA = try XCTUnwrap(model.pending)
        XCTAssertTrue(model.selectComputer(b.id)); await model.refresh()
        XCTAssertNil(model.pending); XCTAssertEqual(model.draft, "")
        model.draft = "only on B"; model.backend = "qwen"
        XCTAssertTrue(model.selectComputer(a.id))
        XCTAssertEqual(model.pending?.id, requestA.id)
        XCTAssertEqual(model.draft, "only on A"); XCTAssertEqual(model.backend, "codex")
        let reopened = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        XCTAssertEqual(reopened.pending?.id, requestA.id)
        XCTAssertTrue(reopened.selectComputer(b.id)); XCTAssertEqual(reopened.draft, "only on B"); XCTAssertNil(reopened.pending)
        XCTAssertEqual(api.calls.filter { $0.path == "v1/tasks" }.count, 1)
    }

    func testLateRefreshFromOldSelectionCannotReplaceTheNewComputerState() async throws {
        let a = computer("a"), b = computer("b"), gate = ReplyGate()
        let apiA = StubAPI { _, _, _ in await gate.wait() }
        let apiB = StubAPI { _, _, _ in try self.state("b") }
        let model = AppModel(storage: store([a, b]), defaults: defaults(), makeAPI: { $0.pin == a.connection.pin ? apiA : apiB })
        let original = Task { await model.refresh() }; await waitFor { gate.waiting }
        XCTAssertTrue(model.selectComputer(b.id)); XCTAssertNil(model.state)
        await model.refresh(); XCTAssertEqual(model.state?.projects.first?.name, "b")
        gate.resolve(try state("a")); await original.value
        XCTAssertEqual(model.connection, b.connection)
        XCTAssertEqual(model.state?.projects.first?.name, "b")
    }

    func testSwitchBackUsesANewContextEvenForTheSameComputer() async throws {
        let a = computer("a"), b = computer("b"), gate = ReplyGate()
        let api = StubAPI { _, _, _ in await gate.wait() }
        let model = AppModel(storage: store([a, b]), defaults: defaults(), makeAPI: { _ in api })
        let context = model.contextID
        let old = Task { await model.refresh() }; await waitFor { gate.waiting }
        XCTAssertTrue(model.selectComputer(b.id)); XCTAssertTrue(model.selectComputer(a.id))
        XCTAssertNotEqual(model.contextID, context)
        gate.resolve(try state("stale")); await old.value
        XCTAssertNil(model.state)
    }

    func testLateSubmissionReceiptClearsOnlyItsOwnerAndDoesNotUnlockAnotherSubmission() async throws {
        let a = computer("a"), b = computer("b"), gateA = ReplyGate(), gateB = ReplyGate()
        let apiA = StubAPI { path, _, _ in path == "v1/tasks" ? await gateA.wait() : try self.state("a") }
        let apiB = StubAPI { path, _, _ in path == "v1/tasks" ? await gateB.wait() : try self.state("b") }
        let model = AppModel(storage: store([a, b]), defaults: defaults(), makeAPI: { $0.pin == a.connection.pin ? apiA : apiB })
        await model.refresh(); model.draft = "A task"; let contextA = model.contextID
        let sendingA = Task { await model.submit(expectedContext: contextA) }; await waitFor { gateA.waiting }
        let pendingA = try XCTUnwrap(model.pending)
        XCTAssertTrue(model.selectComputer(b.id)); await model.refresh(); model.draft = "B task"; let contextB = model.contextID
        let sendingB = Task { await model.submit(expectedContext: contextB) }; await waitFor { gateB.waiting }
        let pendingB = try XCTUnwrap(model.pending)
        gateA.resolve(try json(task("A task", id: pendingA.id))); _ = await sendingA.value
        XCTAssertTrue(model.busy); XCTAssertEqual(model.pending?.id, pendingB.id); XCTAssertEqual(model.draft, "B task")
        gateB.resolve(try json(task("B task", id: pendingB.id))); _ = await sendingB.value
        XCTAssertFalse(model.busy); XCTAssertNil(model.pending)
        XCTAssertTrue(model.selectComputer(a.id)); XCTAssertNil(model.pending)
        XCTAssertEqual(apiA.calls.filter { $0.path == "v1/tasks" }.count, 1)
        XCTAssertEqual(apiB.calls.filter { $0.path == "v1/tasks" }.count, 1)
    }

    func testOfflineComputerCannotShowPreviousTasksOrReceiveStaleControlOrSubmit() async throws {
        let a = computer("a"), b = computer("b")
        let apiA = StubAPI { _, _, _ in try self.state("a", tasks: [self.task("A private task")]) }
        let apiB = StubAPI { _, _, _ in throw URLError(.notConnectedToInternet) }
        let model = AppModel(storage: store([a, b]), defaults: defaults(), makeAPI: { $0.pin == a.connection.pin ? apiA : apiB })
        await model.refresh(); let staleTask = try XCTUnwrap(model.state?.tasks.first); let context = model.contextID
        XCTAssertTrue(model.selectComputer(b.id)); await model.refresh()
        XCTAssertNil(model.state); XCTAssertNotNil(model.connectionError)
        await model.control(task: staleTask, expectedContext: context, expectedRunID: "same-run")
        model.draft = "do not send"
        await model.submit(expectedContext: context)
        XCTAssertEqual(apiB.calls.count, 1); XCTAssertEqual(apiB.calls.first?.path, "v1/state")
    }

    func testOldRunCannotControlEvenAnIdenticalTaskInTheCurrentState() async throws {
        let a = computer("a"), api = StubAPI { _, _, _ in try self.state("a", run: "new-run", tasks: [self.task("task")]) }
        let model = AppModel(storage: store([a]), defaults: defaults(), makeAPI: { _ in api })
        await model.refresh()
        await model.control(task: try XCTUnwrap(model.state?.tasks.first), expectedContext: model.contextID, expectedRunID: "old-run")
        XCTAssertEqual(api.calls.count, 1)
    }

    func testCancelPairingOrSwitchingWhileItWaitsDoesNotReplaceTheSelectedComputer() async throws {
        let a = computer("a"), b = computer("b"), c = computer("c")
        for switchComputer in [false, true] {
            let gate = ReplyGate(), api = StubAPI { _, _, _ in await gate.wait() }
            let storage = store([a, b]), model = AppModel(storage: storage, defaults: defaults(), makeAPI: { _ in api })
            model.preparePairing(link: try pairing(c))
            let pairing = Task { await model.pair() }; await waitFor { gate.waiting }
            if switchComputer { XCTAssertTrue(model.selectComputer(b.id)) } else { model.cancelPairing() }
            gate.resolve(try json(["token": c.connection.token, "runId": "c-run"]))
            let finishedPairing = await pairing.value; XCTAssertFalse(finishedPairing)
            XCTAssertEqual(model.computers.count, 2)
            XCTAssertEqual(model.selectedComputerID, switchComputer ? b.id : a.id)
            XCTAssertFalse(model.connecting)
        }
    }

    func testRenameRepairAndForgetPreserveOtherComputersAndTheirCredentials() async throws {
        let a = computer("a"), b = computer("b"), preferences = defaults(), storage = store([])
        storage.library = ConnectionLibrary(computers: [a, b], selectedID: a.id)
        let api = StubAPI { path, _, _ in path == "v1/pair" ? try self.json(["token": a.connection.token, "runId": "run"]) : try self.state("a") }
        let model = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        model.draft = "keep draft"
        model.renameComputer(a.id, name: "  Work laptop  ")
        model.preparePairing(link: try pairing(a)); let pairedA = await model.pair(); XCTAssertTrue(pairedA)
        XCTAssertEqual(model.computers.count, 2); XCTAssertEqual(model.selectedComputerID, a.id)
        XCTAssertEqual(model.selectedComputer?.displayName, "Work laptop")
        XCTAssertEqual(model.draft, "keep draft")
        model.forgetComputer(a.id)
        XCTAssertEqual(model.connection, b.connection); XCTAssertEqual(model.computers.count, 1)
        let restored = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        XCTAssertEqual(restored.connection, b.connection)
    }

    func testLegacyPendingIsMigratedToItsOwnComputerEvenWhenAnotherIsSelected() async throws {
        let a = computer("a"), b = computer("b"), storage = store([a, b], selected: b.id), preferences = defaults()
        storage.legacy = a.connection
        preferences.set(try JSONEncoder().encode(PendingSubmission(id: "legacy-request", backend: "qwen", project: "old-project", text: "old task", runId: "old-run")), forKey: "pendingSubmission")
        let model = AppModel(storage: storage, defaults: preferences)
        XCTAssertNil(model.pending)
        XCTAssertTrue(model.selectComputer(a.id)); XCTAssertEqual(model.pending?.id, "legacy-request")
        XCTAssertNil(preferences.data(forKey: "pendingSubmission"))
    }

    func testRepairRetainsTheProfileAndDoesNotOverwriteAnotherSavedComputer() async throws {
        let a = computer("a"), b = computer("b"), c = computer("c"), storage = store([a, b])
        let model = AppModel(storage: storage, defaults: defaults(), makeAPI: { connection in
            StubAPI { path, _, _ in
                path == "v1/pair" ? try self.json(["token": String(repeating: String(connection.pin.prefix(1)), count: 43), "runId": "new-run"]) : try self.state("fixture")
            }
        })
        model.renameComputer(a.id, name: "Work laptop")
        model.preparePairing(for: a.id, link: try pairing(c))
        let repaired = await model.pair(); XCTAssertTrue(repaired)
        XCTAssertEqual(model.selectedComputerID, a.id); XCTAssertEqual(model.connection, c.connection)
        XCTAssertEqual(model.selectedComputer?.displayName, "Work laptop")
        model.preparePairing(for: a.id, link: try pairing(b))
        let existing = await model.pair(); XCTAssertTrue(existing)
        XCTAssertEqual(model.selectedComputerID, b.id)
        XCTAssertEqual(model.computers.first(where: { $0.id == a.id })?.connection, c.connection)
        XCTAssertEqual(model.computers.count, 2)
    }

    func testStorageFailureDoesNotSwitchOrOverwriteAnUnreadableRegistry() async throws {
        let a = computer("a"), b = computer("b"), storage = store([a, b])
        let model = AppModel(storage: storage, defaults: defaults())
        storage.failSave = true
        XCTAssertFalse(model.selectComputer(b.id)); XCTAssertEqual(model.connection, a.connection)
        model.forgetComputer(a.id); XCTAssertEqual(model.computers.count, 2)
        storage.failRead = true
        let unreadable = AppModel(storage: storage, defaults: defaults())
        unreadable.preparePairing(link: try pairing(b))
        let unreadablePairing = await unreadable.pair(); XCTAssertFalse(unreadablePairing); XCTAssertEqual(storage.writes, 0)
        XCTAssertNotNil(unreadable.actionError)
    }

    func testFollowupsKeepTheirConversationTargetRunAndDraftAcrossRetryAndRelaunch() async throws {
        let a = computer("a"), b = computer("b"), preferences = defaults(), storage = store([a, b])
        var first = task("Original request", id: "conversation-a")
        first["status"] = "completed"; first["conversationId"] = "conversation-a"; first["turnIndex"] = 1
        let api = StubAPI { path, _, _ in
            if path == "v1/tasks" { throw URLError(.networkConnectionLost) }
            return try self.state("fixture", tasks: [first], continuations: true)
        }
        let model = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        await model.refresh(); let context = model.contextID
        model.draft = "Unrelated new conversation"; model.backend = "codex"
        model.setConversationDraft("Continue the original", conversationID: "conversation-a", runID: "same-run", expectedContext: context)
        await model.submit(expectedContext: context, conversationID: "conversation-a")
        let pending = try XCTUnwrap(model.pending)
        XCTAssertEqual(pending.conversationId, "conversation-a"); XCTAssertEqual(pending.backend, "qwen")
        await model.retryPending(expectedContext: context)
        let calls = api.calls.filter { $0.path == "v1/tasks" }
        XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0].body, calls[1].body)
        XCTAssertEqual(calls[0].body?["conversationId"], "conversation-a")
        XCTAssertEqual(calls[0].body?["backend"], "qwen"); XCTAssertEqual(calls[0].runID, "same-run")
        let reopened = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        XCTAssertEqual(reopened.pending?.id, pending.id)
        XCTAssertEqual(reopened.conversationDraft(conversationID: "conversation-a", runID: "same-run"), "Continue the original")
        XCTAssertEqual(reopened.draft, "Unrelated new conversation")
        XCTAssertTrue(reopened.selectComputer(b.id))
        XCTAssertEqual(reopened.conversationDraft(conversationID: "conversation-a", runID: "same-run"), "")
        reopened.setConversationDraft("stale write", conversationID: "conversation-a", runID: "same-run", expectedContext: context)
        await reopened.submit(expectedContext: context, conversationID: "conversation-a")
        XCTAssertEqual(api.calls.filter { $0.path == "v1/tasks" }.count, 2)
    }

    func testConversationGroupingPreservesTurnOrderAndLegacySingleTasks() throws {
        var first = task("Original", id: "first")
        first["conversationId"] = "first"; first["turnIndex"] = 1; first["status"] = "completed"
        var second = task("Follow up", id: "second")
        second["conversationId"] = "first"; second["turnIndex"] = 2
        let decoded = try JSONDecoder().decode(RemoteState.self, from: state("fixture", tasks: [second, task("Legacy", id: "legacy"), first]))
        XCTAssertEqual(decoded.conversations.count, 2)
        let conversation = try XCTUnwrap(decoded.conversations.first { $0.id == "first" })
        XCTAssertEqual(conversation.turns.map(\.id), ["first", "second"])
        XCTAssertEqual(conversation.first.request, "Original"); XCTAssertFalse(conversation.canContinue)
    }

    func testFollowupReceiptClearsOnlyItsDraftAndRestartNeverReplaysPending() async throws {
        let a = computer("a"), storage = store([a]), preferences = defaults()
        var first = task("Original", id: "conversation")
        first["status"] = "completed"; first["conversationId"] = "conversation"; first["turnIndex"] = 1
        var run = "original-run"
        var fail = false
        let api = StubAPI { path, body, _ in
            if path == "v1/tasks" {
                if fail { throw URLError(.networkConnectionLost) }
                var receipt = self.task(body!["text"]!, id: body!["id"]!)
                receipt["conversationId"] = body!["conversationId"]
                return try self.json(receipt)
            }
            return try self.state("fixture", run: run, tasks: [first], continuations: true)
        }
        let model = AppModel(storage: storage, defaults: preferences, makeAPI: { _ in api })
        await model.refresh(); let context = model.contextID
        model.draft = "Keep the new-conversation draft"
        model.setConversationDraft("Keep another conversation", conversationID: "other", runID: run, expectedContext: context)
        model.setConversationDraft("Follow up", conversationID: "conversation", runID: run, expectedContext: context)
        let result = await model.submit(expectedContext: context, conversationID: "conversation")
        XCTAssertEqual(result, "conversation"); XCTAssertNil(model.pending)
        XCTAssertEqual(model.conversationDraft(conversationID: "conversation", runID: run), "")
        XCTAssertEqual(model.conversationDraft(conversationID: "other", runID: run), "Keep another conversation")
        XCTAssertEqual(model.draft, "Keep the new-conversation draft")
        fail = true
        model.setConversationDraft("Unconfirmed", conversationID: "conversation", runID: run, expectedContext: context)
        await model.submit(expectedContext: context, conversationID: "conversation")
        let pending = try XCTUnwrap(model.pending)
        run = "restarted-run"; await model.refresh()
        await model.retryPending(expectedContext: context)
        XCTAssertEqual(api.calls.filter { $0.path == "v1/tasks" }.count, 2)
        XCTAssertEqual(model.pending?.id, pending.id)
        XCTAssertEqual(model.conversationDraft(conversationID: "conversation", runID: run), "")
    }

    func testMismatchedReceiptCannotClearPendingAndOldGatewayCannotStartFollowup() async throws {
        let a = computer("a"), storage = store([a]), api = StubAPI { path, _, _ in
            if path == "v1/tasks" { return try self.json(self.task("Wrong response")) }
            return try self.state("fixture")
        }
        let model = AppModel(storage: storage, defaults: defaults(), makeAPI: { _ in api })
        await model.refresh(); model.draft = "Actual request"
        await model.submit(expectedContext: model.contextID)
        XCTAssertNotNil(model.pending); XCTAssertEqual(model.draft, "Actual request")
        model.clearPending()
        await model.submit(expectedContext: model.contextID, conversationID: "old-conversation")
        XCTAssertEqual(api.calls.filter { $0.path == "v1/tasks" }.count, 1)
    }
}
