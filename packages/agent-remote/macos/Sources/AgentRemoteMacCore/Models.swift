import Foundation

public struct DesktopConfig: Codable, Equatable {
    public var version: Int
    public var projects: [String]
    public var port: Int
    public var ask: Bool
    public var launchAtLogin: Bool
}

public struct AgentStatus: Decodable, Identifiable {
    public let id: String
    public let name: String
    public let installed: Bool
    public let executable: String?
    public let status: String
}

public struct DesktopSnapshot: Decodable {
    public let version: Int
    public let name: String
    public let config: DesktopConfig
    public let directory: String
    public let loaded: Bool
    public let online: Bool
    public let runId: String?
    public let pid: Int?
    public let permissionMode: String
    public let activeTasks: Int
    public let totalTasks: Int
    public let addresses: [String]
    public let agents: [AgentStatus]
}

public struct PairingInfo: Decodable {
    public let link: String
    public let url: String
    public let expiresAt: Double
    public let runId: String
    public var expiry: Date { Date(timeIntervalSince1970: expiresAt / 1000) }
}

public enum BridgeError: LocalizedError {
    case missingRuntime, failed(String), timedOut, invalidResponse
    public var errorDescription: String? {
        switch self {
        case .missingRuntime: return "The bundled runtime is missing. Reinstall Agent Remote."
        case .failed(let text): return text
        case .timedOut: return "The background service did not respond in time. Check its status and logs before retrying."
        case .invalidResponse: return "The background service returned an unsupported response."
        }
    }
}

public enum AgentPaths {
    public static func searchPath(runtimeBin: String, inherited: String, home: String, fileManager: FileManager = .default) -> String {
        var paths = [runtimeBin] + inherited.split(separator: ":").map(String.init)
        paths += [".local/bin", ".npm-global/bin", ".volta/bin", ".asdf/shims", ".bun/bin", "bin"].map { home + "/" + $0 }
        let nvm = home + "/.nvm/versions/node"
        if let versions = try? fileManager.contentsOfDirectory(atPath: nvm) {
            paths += versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { nvm + "/" + $0 + "/bin" }
        }
        paths += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        return paths.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }
}
