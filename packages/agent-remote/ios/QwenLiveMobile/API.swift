import Foundation
import CryptoKit
import Security

final class PinnedSessionDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    private let pin: String
    private let host: String
    init(pin: String, host: String) { self.pin = pin; self.host = host.lowercased() }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host.lowercased() == host,
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = certificates.first else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let data = SecCertificateCopyData(certificate) as Data
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == pin else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        // Trust only the physically paired certificate, then retain the system's
        // hostname, expiry and TLS server-use checks against that private anchor.
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        var error: CFError?
        guard SecTrustEvaluateWithError(trust, &error) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

protocol RemoteAPI {
    func request<T: Decodable>(_ path: String, body: [String: String]?, runId: String?) async throws -> T
}

extension RemoteAPI {
    func request<T: Decodable>(_ path: String) async throws -> T { try await request(path, body: nil, runId: nil) }
}

final class MobileAPI: RemoteAPI {
    private struct Problem: Decodable { let error: String }
    let connection: MacConnection
    private let session: URLSession
    init(_ connection: MacConnection) {
        self.connection = connection
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration,
                             delegate: PinnedSessionDelegate(pin: connection.pin, host: URL(string: connection.url)!.host!),
                             delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    func request<T: Decodable>(_ path: String, body: [String: String]? = nil, runId: String? = nil) async throws -> T {
        let base = URL(string: connection.url)!
        // ATS permits the paired private IPv4 certificate, but this client
        // never permits plaintext HTTP, redirects or an unpinned certificate.
        guard base.scheme == "https" else { throw MobileFailure.invalidPairing }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if !connection.token.isEmpty { request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization") }
        if let runId { request.setValue(runId, forHTTPHeaderField: "X-Live-Run-Id") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw MobileFailure.invalidResponse }
        guard (200...299).contains(response.statusCode) else {
            throw MobileFailure.remote(response.statusCode, (try? JSONDecoder().decode(Problem.self, from: data))?.error ?? "operationFailed")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

protocol ConnectionPersistence {
    func loadLibrary() throws -> ConnectionLibrary?
    func loadLegacy() throws -> MacConnection?
    func saveLibrary(_ library: ConnectionLibrary) throws
}

struct ConnectionStore: ConnectionPersistence {
    let service: String
    init(service: String = "com.qwenlive.mobile.connection") { self.service = service }

    func saveLibrary(_ library: ConnectionLibrary) throws {
        try library.validate()
        let data = try JSONEncoder().encode(library)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "paired-computers-v1"]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            let result = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard result == errSecSuccess else { throw MobileFailure.invalidResponse }
        } else if updated != errSecSuccess { throw MobileFailure.invalidResponse }
        // Commit the complete library first. The obsolete single-host record
        // must not keep a forgotten computer's credential or revive on downgrade.
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrAccount as String: "paired-mac"] as CFDictionary)
    }
    private func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw MobileFailure.invalidResponse }
        return data
    }
    func loadLibrary() throws -> ConnectionLibrary? {
        guard let data = try read("paired-computers-v1") else { return nil }
        let library = try JSONDecoder().decode(ConnectionLibrary.self, from: data)
        try library.validate()
        return library
    }
    func loadLegacy() throws -> MacConnection? {
        guard let data = try read("paired-mac") else { return nil }
        return try JSONDecoder().decode(MacConnection.self, from: data)
    }
}
