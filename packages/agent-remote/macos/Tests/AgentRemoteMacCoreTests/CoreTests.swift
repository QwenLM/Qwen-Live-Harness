import XCTest
@testable import AgentRemoteMacCore

final class CoreTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("agent-remote-native-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    func testBundledNodeIsFirstAndFinderDiscoversVersionManagedAgents() throws {
        let home = try directory()
        for version in ["v9.0.0", "v22.22.2", "v20.0.0"] {
            try FileManager.default.createDirectory(at: home.appendingPathComponent(".nvm/versions/node/" + version + "/bin"), withIntermediateDirectories: true)
        }
        let paths = AgentPaths.searchPath(runtimeBin: "/bundled/bin", inherited: "/usr/bin:/usr/bin:/custom/bin", home: home.path).components(separatedBy: ":")
        XCTAssertEqual(paths.first, "/bundled/bin")
        XCTAssertEqual(paths.filter { $0 == "/usr/bin" }.count, 1)
        XCTAssertLessThan(try XCTUnwrap(paths.firstIndex { $0.contains("v22.22.2") }), try XCTUnwrap(paths.firstIndex { $0.contains("v9.0.0") }))
        XCTAssertTrue(paths.contains(home.path + "/.local/bin"))
    }
    func testSnapshotKeepsDetectedAndVerifiedAgentStatusesDistinct() throws {
        let data = Data(#"{"version":1,"name":"Test Mac","config":{"version":1,"projects":["/fixture"],"port":47421,"ask":false,"launchAtLogin":true},"directory":"/private/fixture","loaded":true,"online":true,"runId":"owned-run","pid":1,"permissionMode":"allow-all","activeTasks":2,"totalTasks":3,"addresses":["https://192.168.1.2:47421"],"agents":[{"id":"qwen","name":"Qwen Code","installed":true,"status":"ready"},{"id":"codex","name":"Codex","installed":false,"status":"available"}]}"#.utf8)
        let snapshot = try JSONDecoder().decode(DesktopSnapshot.self, from: data)
        XCTAssertEqual(snapshot.activeTasks, 2)
        XCTAssertEqual(snapshot.agents.first?.status, "ready")
        XCTAssertEqual(snapshot.agents.last?.installed, false)
        XCTAssertEqual(snapshot.permissionMode, "allow-all")
    }
    func testMissingRuntimeDoesNotFallBackToSystemNode() async throws {
        let root = try directory(), bridge = GatewayBridge(bundle: root)
        do { _ = try await bridge.execute(["snapshot"]); XCTFail("A broken app must not use the developer's Node installation") }
        catch BridgeError.missingRuntime { }
    }
    private func bridge(_ script: String) throws -> (GatewayBridge, URL) {
        let root = try directory()
        let node = root.appendingPathComponent("Contents/Resources/runtime/bin/node")
        let cli = root.appendingPathComponent("Contents/Resources/gateway/dist/cli.js")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(("#!/bin/sh\n" + script).utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try Data().write(to: cli)
        return (GatewayBridge(bundle: root, environment: ["CAPTURE": root.appendingPathComponent("arguments").path]), root)
    }
    func testFolderPathsAreArgumentsAndNeverShellCommands() async throws {
        let (bridge, root) = try bridge("printf '%s\\n' \"$@\" > \"$CAPTURE\"\nprintf '{\"ok\":true}'\n")
        struct Reply: Decodable { let ok: Bool }
        let path = "/fixture/My Project & $(literal)"
        let reply: Reply = try await bridge.request(["configure", "--project", path])
        XCTAssertTrue(reply.ok)
        let arguments = try String(contentsOf: root.appendingPathComponent("arguments"), encoding: .utf8)
        XCTAssertTrue(arguments.hasSuffix("desktop\nconfigure\n--project\n" + path + "\n"))
    }
    func testTimeoutTerminatesOnlyItsOwnedHelper() async throws {
        let (bridge, _) = try bridge("exec /bin/sleep 10\n")
        do { _ = try await bridge.execute(["snapshot"], timeout: 0.05); XCTFail("Timed-out helper should not hang the UI") }
        catch BridgeError.timedOut { }
    }
    func testCommandFailureRetainsUsefulErrorInsteadOfClaimingSuccess() async throws {
        let (bridge, _) = try bridge("printf 'fixture service unavailable' >&2\nexit 2\n")
        do { _ = try await bridge.execute(["start"]); XCTFail("Failure must not become a success") }
        catch BridgeError.failed(let message) { XCTAssertEqual(message, "fixture service unavailable") }
    }
}
