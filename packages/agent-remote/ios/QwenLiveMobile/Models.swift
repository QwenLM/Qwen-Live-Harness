import Foundation

func tr(_ key: String) -> String { NSLocalizedString(key, comment: "") }

struct Pairing: Codable {
    let version: Int
    let url: String
    let pin: String
    let code: String
    let name: String

    static func parse(_ text: String) throws -> Pairing {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count < 8192,
              let components = URLComponents(string: value),
              ["qwenliveharness", "qwenlive"].contains(components.scheme ?? ""), components.host == "pair",
              let encoded = components.queryItems?.first(where: { $0.name == "data" })?.value else {
            throw MobileFailure.invalidPairing
        }
        var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let pairing = try? JSONDecoder().decode(Pairing.self, from: data),
              pairing.version == 1,
              let endpoint = URLComponents(string: pairing.url), endpoint.scheme == "https",
              endpoint.host?.isEmpty == false, endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil,
              ["", "/"].contains(endpoint.path),
              pairing.pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              pairing.code.count >= 32, pairing.code.count <= 128, pairing.name.count <= 256 else {
            throw MobileFailure.invalidPairing
        }
        return pairing
    }
}

struct MacConnection: Codable, Equatable {
    let url: String
    let pin: String
    let token: String
    let name: String

    var isValid: Bool {
        guard let endpoint = URLComponents(string: url) else { return false }
        return endpoint.scheme == "https" && endpoint.host?.isEmpty == false &&
            endpoint.user == nil && endpoint.password == nil && endpoint.query == nil && endpoint.fragment == nil &&
            ["", "/"].contains(endpoint.path) && pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
            token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil && name.count <= 256
    }
}

struct SavedComputer: Codable, Identifiable, Equatable {
    let id: UUID
    var connection: MacConnection
    var nickname: String?
    var displayName: String { nickname ?? connection.name }
}

struct ConnectionLibrary: Codable {
    var version = 1
    var computers: [SavedComputer]
    var selectedID: UUID?

    func validate() throws {
        guard version == 1, Set(computers.map(\.id)).count == computers.count,
              computers.allSatisfy({ $0.connection.isValid }),
              selectedID == nil || computers.contains(where: { $0.id == selectedID }) else {
            throw MobileFailure.invalidResponse
        }
    }
}

struct ComputerWorkspace: Codable {
    var draft = ""
    var backend = ""
    var project = ""
    var pending: PendingSubmission?
}

struct TaskRoute: Hashable {
    let contextID: UUID
    let taskID: String
}

struct RemoteState: Decodable {
    let version: Int
    let runId: String
    let permissionMode: String?
    let backends: [RemoteBackend]
    let projects: [RemoteProject]
    let tasks: [RemoteTask]
}

struct RemoteBackend: Decodable, Identifiable {
    let id: String
    let name: String
    let status: String
}

struct RemoteProject: Decodable, Identifiable {
    let id: String
    let name: String
    let path: String
}

struct RemoteTask: Decodable, Identifiable {
    let id: String
    let backend: String
    let project: String
    let request: String
    let status: String
    let createdAt: Double
    let updatedAt: Double
    let activity: String
    let output: String
    let outputTruncated: Bool
    let permissions: [RemotePermission]
    let events: [RemoteEvent]
    var terminal: Bool { ["completed", "failed", "cancelled", "interrupted"].contains(status) }
}

struct RemotePermission: Decodable, Identifiable {
    let id: String
    let title: String
    let toolName: String?
    let command: String?
    let cwd: String?
    let input: String?
    let canAllow: Bool
}

struct RemoteEvent: Decodable, Identifiable {
    let id: String
    let kind: String
    let text: String
    let at: Double
}

struct PendingSubmission: Codable {
    let id: String
    let backend: String
    let project: String
    let text: String
    let runId: String
}

enum MobileFailure: LocalizedError {
    case invalidPairing
    case remote(Int, String)
    case invalidResponse
    var errorDescription: String? {
        switch self {
        case .invalidPairing: return tr("invalidPairing")
        case .invalidResponse: return tr("invalidResponse")
        case .remote(_, let code):
            let localized = tr(code)
            return localized == code ? tr("operationFailed") + " (" + code + ")" : localized
        }
    }
}
