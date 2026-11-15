import Foundation
import Security
import Combine

struct OmniLiveConfiguration: Codable, Equatable {
    let apiKey: String
    let workspace: String
    let region: String
    var origin: String { "https://" + workspace + "." + region + ".maas.aliyuncs.com" }
    func validate() throws {
        guard apiKey.hasPrefix("sk-"), (12...4096).contains(apiKey.utf8.count),
              apiKey.utf8.allSatisfy({ (33...126).contains($0) }),
              workspace.range(of: #"^[a-z0-9][a-z0-9-]{0,62}$"#, options: .regularExpression) != nil,
              ["cn-beijing", "ap-southeast-1"].contains(region) else { throw MobileFailure.remote(400, "liveInvalidConfiguration") }
    }
}

protocol OmniLivePersistence {
    func load() throws -> OmniLiveConfiguration?
    func save(_ configuration: OmniLiveConfiguration) throws
    func delete() throws
}

struct OmniLiveKeychain: OmniLivePersistence {
    var service = "com.qwenlive.mobile.omni-live"
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
        kSecAttrAccount as String: "dashscope-v1", kSecAttrSynchronizable as String: false] }
    func load() throws -> OmniLiveConfiguration? {
        var attributes = query; attributes[kSecReturnData as String] = true; attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw MobileFailure.remote(500, "liveKeychainFailed") }
        let value = try JSONDecoder().decode(OmniLiveConfiguration.self, from: data); try value.validate(); return value
    }
    func save(_ configuration: OmniLiveConfiguration) throws {
        try configuration.validate()
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(configuration),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw MobileFailure.remote(500, "liveKeychainFailed") }
    }
    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MobileFailure.remote(500, "liveKeychainFailed") }
    }
}

@MainActor final class OmniLiveSettings: ObservableObject {
    @Published private(set) var configured = false
    @Published private(set) var workspace = ""
    @Published private(set) var region = "cn-beijing"
    @Published private(set) var revision = UUID()
    @Published private(set) var error: String?
    private let storage: any OmniLivePersistence
    private let issue: (OmniLiveConfiguration) async throws -> OmniLiveCredentials
    init(storage: (any OmniLivePersistence)? = nil,
         issue: @escaping (OmniLiveConfiguration) async throws -> OmniLiveCredentials = { try await OmniLiveTokenClient.issue($0) }) {
        var defaultStorage = OmniLiveKeychain()
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--uitesting") || ProcessInfo.processInfo.arguments.contains("--uitesting-live-persist") {
            defaultStorage.service += ".uitesting"
            if ProcessInfo.processInfo.arguments.contains("--uitesting"), storage == nil { try? defaultStorage.delete() }
        }
        #endif
        let storage = storage ?? defaultStorage
        self.storage = storage; self.issue = issue
        do {
            if let value = try storage.load() { configured = true; workspace = value.workspace; region = value.region }
        } catch { self.error = tr("liveKeychainFailed") }
    }
    @discardableResult func save(apiKey: String, workspace: String, region: String) -> Bool {
        do {
            let supplied = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = supplied.isEmpty ? try storage.load()?.apiKey ?? "" : supplied
            let value = OmniLiveConfiguration(apiKey: key, workspace: workspace.trimmingCharacters(in: .whitespacesAndNewlines), region: region)
            try value.validate(); try storage.save(value)
            configured = true; self.workspace = value.workspace; self.region = value.region; error = nil; revision = UUID(); return true
        } catch { self.error = error is MobileFailure ? error.localizedDescription : tr("liveKeychainFailed"); return false }
    }
    func delete() {
        do { try storage.delete(); configured = false; workspace = ""; region = "cn-beijing"; error = nil; revision = UUID() }
        catch { self.error = tr("liveKeychainFailed") }
    }
    func credentials() async throws -> OmniLiveCredentials {
        guard let value = try storage.load() else { throw MobileFailure.remote(400, "liveConfigureFirst") }
        let revision = self.revision
        let token = try await issue(value)
        try Task.checkCancellation()
        guard self.revision == revision else { throw CancellationError() }
        try token.validate(); return token
    }
}

enum OmniLiveTokenClient {
    // Refuse redirects so the user's own key is sent only to their selected
    // Alibaba Cloud workspace, once, over the system-validated TLS connection.
    private final class Delegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    static func issue(_ configuration: OmniLiveConfiguration) async throws -> OmniLiveCredentials {
        try configuration.validate(); try Task.checkCancellation()
        var request = URLRequest(url: URL(string: configuration.origin + "/api/v1/tokens?expire_in_seconds=60")!)
        request.httpMethod = "POST"; request.timeoutInterval = 12
        request.setValue("Bearer " + configuration.apiKey, forHTTPHeaderField: "Authorization")
        let options = URLSessionConfiguration.ephemeral; options.urlCache = nil; options.httpCookieStorage = nil
        options.timeoutIntervalForResource = 15
        let session = URLSession(configuration: options, delegate: Delegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw MobileFailure.remote((error as NSError).code, "liveConnectionFailed") }
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw OmniLiveFailure.connection }
        if [401, 403].contains(http.statusCode) { throw MobileFailure.remote(http.statusCode, "liveKeyRejected") }
        guard http.statusCode == 200 else { throw MobileFailure.remote(http.statusCode, "liveConnectionFailed") }
        guard data.count <= 16_384 else { throw OmniLiveFailure.protocolError }
        struct Token: Decodable { let token: String; let expires_at: Double }
        guard let value = try? JSONDecoder().decode(Token.self, from: data) else { throw OmniLiveFailure.protocolError }
        let credentials = OmniLiveCredentials(model: "qwen3.8-omni-flash-realtime",
            url: configuration.origin.replacingOccurrences(of: "https:", with: "wss:") + "/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime",
            token: value.token, expiresAt: value.expires_at)
        try credentials.validate(); return credentials
    }
}
