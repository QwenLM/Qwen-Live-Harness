import XCTest
@testable import QwenLiveMobile

@MainActor
final class AssistantTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "agent-remote-assistant-tests-" + UUID().uuidString
        addTeardownBlock { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        return UserDefaults(suiteName: name)!
    }

    func testInputsDraftPreferencesAndFavoritesSurviveRelaunchWithoutTouchingWorkbench() throws {
        let storage = defaults()
        storage.set("existing workbench data", forKey: "computerWorkspaces.v1")
        let model = AssistantModel(defaults: storage)
        model.draft = "  Capture this idea, do not execute it.\n"
        let input = try XCTUnwrap(model.saveInput(source: .voice))
        XCTAssertEqual(input.text, "Capture this idea, do not execute it.")
        XCTAssertEqual(input.source, .voice)
        XCTAssertEqual(model.draft, "")
        model.appearance = .dark; model.dictationLanguage = .chinese
        model.toggleFavorite("computer-a.run-a.task-a")
        model.draft = "unfinished input"
        let reopened = AssistantModel(defaults: storage)
        XCTAssertEqual(reopened.inputs, [input])
        XCTAssertEqual(reopened.draft, "unfinished input")
        XCTAssertEqual(reopened.appearance, .dark)
        XCTAssertEqual(reopened.dictationLanguage, .chinese)
        XCTAssertTrue(reopened.favorites.contains("computer-a.run-a.task-a"))
        XCTAssertEqual(storage.string(forKey: "computerWorkspaces.v1"), "existing workbench data")
        reopened.deleteInput(input.id)
        XCTAssertTrue(AssistantModel(defaults: storage).inputs.isEmpty)
        XCTAssertEqual(AssistantModel(defaults: storage).draft, "unfinished input")
    }

    func testInvalidStorageIsPreservedAndDoesNotProduceFalseSaveReceipt() {
        let storage = defaults(), damaged = Data("unreadable input data".utf8)
        storage.set(damaged, forKey: AssistantModel.storageKey)
        let model = AssistantModel(defaults: storage)
        model.draft = "Keep this draft"
        XCTAssertNil(model.saveInput(source: .text))
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.draft, "Keep this draft")
        XCTAssertEqual(storage.data(forKey: AssistantModel.storageKey), damaged)
    }

    func testWhitespaceAndOversizedInputNeverCreateAnItemOrClearItsDraft() {
        let model = AssistantModel(defaults: defaults())
        model.draft = " \n "
        XCTAssertNil(model.saveInput(source: .text))
        model.draft = String(repeating: "x", count: 20_001)
        XCTAssertNil(model.saveInput(source: .text))
        XCTAssertEqual(model.draft.count, 20_001)
        XCTAssertTrue(model.inputs.isEmpty)
    }

    private func task(_ id: String, conversation: String? = nil, at: Double = 1000,
                      status: String = "completed", artifacts: [[String: Any]] = []) -> [String: Any] {
        ["id": id, "conversationId": conversation ?? id, "backend": "fake", "project": "fixture",
         "request": "Request " + id, "status": status, "createdAt": at, "updatedAt": at,
         "activity": "Working " + id, "output": "Result " + id, "outputTruncated": false,
         "artifacts": artifacts, "permissions": [], "events": []]
    }
    private func state(_ tasks: [[String: Any]], run: String = "run-a") throws -> RemoteState {
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "runId": run,
            "backends": [], "projects": [], "tasks": tasks])
        return try JSONDecoder().decode(RemoteState.self, from: data)
    }

    func testRecentItemsAreRealLatestTurnsAndLimitedToThree() throws {
        XCTAssertTrue(PersonalActivity.recent(state: nil, computerID: nil, contextID: UUID(), inputs: []).isEmpty)
        let remote = try state([task("old", conversation: "shared", at: 1), task("new", conversation: "shared", at: 2),
                                task("second", at: 3), task("third", at: 4), task("fourth", at: 5)])
        let items = PersonalActivity.recent(state: remote, computerID: UUID(), contextID: UUID(), inputs: [])
        XCTAssertEqual(items.map(\.title), ["Request fourth", "Request third", "Request second"])
        XCTAssertEqual(Set(items.map(\.id)).count, 3)
    }

    func testActivityLinksRejectOtherComputerContextRunAndMissingTask() throws {
        let computer = UUID(), context = UUID(), remote = try state([task("same-task", conversation: "same-conversation")])
        let item = try XCTUnwrap(PersonalActivity.recent(state: remote, computerID: computer, contextID: context, inputs: []).first)
        let link = try XCTUnwrap(item.link)
        XCTAssertEqual(link.route(computerID: computer, contextID: context, state: remote)?.runID, "run-a")
        XCTAssertNil(link.route(computerID: UUID(), contextID: context, state: remote))
        XCTAssertNil(link.route(computerID: computer, contextID: UUID(), state: remote))
        XCTAssertNil(link.route(computerID: computer, contextID: context, state: try state([task("same-task", conversation: "same-conversation")], run: "run-b")))
        XCTAssertNil(link.route(computerID: computer, contextID: context, state: try state([task("another", conversation: "same-conversation")])))
        XCTAssertNil(link.route(computerID: computer, contextID: context, state: nil))
    }

    func testFeedKeepsArtifactOwnershipAndDoesNotInventRunningResults() throws {
        let artifact: [String: Any] = ["id": "same-artifact", "name": "report.md", "mimeType": "text/markdown", "kind": "markdown", "size": 10]
        let remote = try state([task("turn-one", conversation: "shared", at: 1, artifacts: [artifact]),
                                task("turn-two", conversation: "shared", at: 2, artifacts: [artifact]),
                                task("busy", at: 3, status: "running")])
        let computer = UUID(), context = UUID()
        let items = PersonalActivity.feed(state: remote, computerID: computer, contextID: context, inputs: [])
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(Set(items.map(\.id)).count, 2)
        XCTAssertEqual(Set(items.compactMap { $0.link?.taskID }), ["turn-one", "turn-two"])
        let otherComputer = PersonalActivity.feed(state: remote, computerID: UUID(), contextID: context, inputs: [])
        XCTAssertTrue(Set(items.map(\.id)).isDisjoint(with: otherComputer.map(\.id)))
        let restarted = PersonalActivity.feed(state: try state([task("turn-one", artifacts: [artifact])], run: "run-b"),
                                             computerID: computer, contextID: context, inputs: [])
        XCTAssertTrue(Set(items.map(\.id)).isDisjoint(with: restarted.map(\.id)))
    }

    func testLocalInputIsPendingDataAndIsNotAnExecutionLink() throws {
        let local = AssistantInput(id: UUID(), text: "Please run a task", createdAt: Date(), source: .text)
        let item = try XCTUnwrap(PersonalActivity.feed(state: nil, computerID: nil, contextID: UUID(), inputs: [local]).first)
        XCTAssertNil(item.link)
        if case .input(let input) = item.content { XCTAssertEqual(input, local) }
        else { XCTFail("Local capture must not fabricate a task") }
    }
}

@MainActor
private final class FakeVoiceSource: VoiceInputSource {
    var holdAuthorization = false
    var authorization: CheckedContinuation<Void, Error>?
    var authorizeError: Error?
    var startError: Error?
    var starts = 0
    var stops = 0
    var updates: [(String) -> Void] = []
    var endings: [(Error?) -> Void] = []
    func authorize(localeIdentifier: String) async throws {
        if let authorizeError { throw authorizeError }
        if holdAuthorization { try await withCheckedThrowingContinuation { authorization = $0 } }
    }
    func start(onText: @escaping (String) -> Void, onEnd: @escaping (Error?) -> Void) throws {
        if let startError { throw startError }
        starts += 1; updates.append(onText); endings.append(onEnd)
    }
    func stop() { stops += 1 }
}

@MainActor
final class VoiceInputTests: XCTestCase {
    func testPermissionFailureAndStartFailureDoNotLeaveCaptureActive() async {
        let source = FakeVoiceSource()
        source.authorizeError = VoiceInputFailure.permission
        let voice = VoiceInputModel(source: source)
        await voice.start(localeIdentifier: "en-US")
        XCTAssertEqual(source.starts, 0); XCTAssertEqual(voice.phase, .idle); XCTAssertNotNil(voice.error)
        source.authorizeError = nil; source.startError = VoiceInputFailure.noInput
        await voice.start(localeIdentifier: "en-US")
        XCTAssertEqual(voice.phase, .idle); XCTAssertEqual(source.stops, 2)
    }

    func testCancelledAuthorizationCannotStartAudioLater() async {
        let source = FakeVoiceSource(); source.holdAuthorization = true
        let voice = VoiceInputModel(source: source)
        let task = Task { await voice.start(localeIdentifier: "en-US") }
        for _ in 0..<1000 { if source.authorization != nil { break }; await Task.yield() }
        XCTAssertNotNil(source.authorization)
        voice.stop(); source.authorization?.resume(); source.authorization = nil
        await task.value
        XCTAssertEqual(voice.phase, .idle); XCTAssertEqual(source.starts, 0)
    }

    func testLateTextAndErrorCannotOverwriteAnotherRecording() async {
        let source = FakeVoiceSource()
        let model = VoiceInputModel(source: source)
        await model.start(localeIdentifier: "en-US")
        source.updates[0]("first partial")
        model.stop()
        source.updates[0]("late text")
        XCTAssertEqual(model.transcript, "first partial")
        await model.start(localeIdentifier: "en-US")
        source.updates[1]("second partial")
        source.updates[0]("stale text"); source.endings[0](VoiceInputFailure.interrupted)
        XCTAssertEqual(model.transcript, "second partial"); XCTAssertEqual(model.phase, .recording)
        source.endings[1](VoiceInputFailure.interrupted)
        XCTAssertEqual(model.phase, .idle); XCTAssertEqual(model.transcript, "second partial")
        XCTAssertNotNil(model.error)
    }
}
