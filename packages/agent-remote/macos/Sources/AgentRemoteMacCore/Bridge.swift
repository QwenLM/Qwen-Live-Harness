import Foundation

public final class GatewayBridge: Sendable {
    public let bundle: URL
    public let node: URL
    public let cli: URL
    public let environment: [String: String]

    public init(bundle: URL, environment: [String: String] = ProcessInfo.processInfo.environment, home: String? = nil) {
        self.bundle = bundle
        let resources = bundle.appendingPathComponent("Contents/Resources")
        node = resources.appendingPathComponent("runtime/bin/node")
        cli = resources.appendingPathComponent("gateway/dist/cli.js")
        var prepared = environment
        prepared["PATH"] = AgentPaths.searchPath(runtimeBin: node.deletingLastPathComponent().path, inherited: environment["PATH"] ?? "", home: home ?? environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path)
        self.environment = prepared
    }

    public func request<T: Decodable>(_ command: [String], timeout: TimeInterval = 90) async throws -> T {
        let data = try await execute(command, timeout: timeout)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw BridgeError.invalidResponse }
    }

    public func execute(_ command: [String], timeout: TimeInterval = 45) async throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else { throw BridgeError.missingRuntime }
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("agent-remote-ui-" + UUID().uuidString)
                var handles: [FileHandle] = []
                defer {
                    handles.forEach { try? $0.close() }
                    try? FileManager.default.removeItem(at: temporary)
                }
                do {
                    try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    let output = temporary.appendingPathComponent("stdout"), errors = temporary.appendingPathComponent("stderr")
                    for url in [output, errors] { FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
                    let stdout = try FileHandle(forWritingTo: output), stderr = try FileHandle(forWritingTo: errors)
                    handles = [stdout, stderr]
                    let process = Process()
                    process.executableURL = self.node
                    process.arguments = [self.cli.path, "desktop"] + command
                    process.environment = self.environment
                    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
                    process.standardOutput = stdout; process.standardError = stderr
                    let watchdog = ProcessWatchdog(process)
                    try process.run()
                    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { watchdog.cancelIfRunning() }
                    process.waitUntilExit()
                    let expired = watchdog.finish()
                    if expired { throw BridgeError.timedOut }
                    let data = try Data(contentsOf: output)
                    guard data.count < 1_048_576 else { throw BridgeError.invalidResponse }
                    if process.terminationStatus != 0 {
                        let errorData = try Data(contentsOf: errors)
                        let text = String(data: errorData.suffix(8192), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Service operation failed"
                        throw BridgeError.failed(text)
                    }
                    continuation.resume(returning: data)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}

private final class ProcessWatchdog: @unchecked Sendable {
    private let lock = NSLock()
    private let process: Process
    private var finished = false
    private var expired = false
    init(_ process: Process) { self.process = process }
    func cancelIfRunning() {
        lock.lock(); defer { lock.unlock() }
        if !finished && process.isRunning { expired = true; process.terminate() }
    }
    func finish() -> Bool {
        lock.lock(); defer { lock.unlock() }
        finished = true; return expired
    }
}
