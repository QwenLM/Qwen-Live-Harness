import XCTest
@testable import QwenLiveMobile

final class PairingTests: XCTestCase {
    private func link(_ fields: [String: Any]) throws -> String {
        let encoded = try JSONSerialization.data(withJSONObject: fields).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "qwenliveharness://pair?data=" + encoded
    }
    func testPinnedHTTPSPairing() throws {
        let value = try link(["version": 1, "url": "https://192.168.1.2:47421", "pin": String(repeating: "a", count: 64), "code": String(repeating: "b", count: 43), "name": "My Mac"])
        XCTAssertEqual(try Pairing.parse(value).name, "My Mac")
        XCTAssertEqual(try Pairing.parse(value.replacingOccurrences(of: "qwenliveharness://", with: "qwenlive://")).name, "My Mac")
    }
    func testRejectsUntrustedPairingVariants() throws {
        let defaults: [String: Any] = ["version": 1, "url": "https://127.0.0.1:47421", "pin": String(repeating: "a", count: 64), "code": String(repeating: "b", count: 43), "name": "Mac"]
        for change in [["url": "http://127.0.0.1"], ["url": "https://user:pass@127.0.0.1"], ["url": "https://127.0.0.1/tasks"], ["url": "https://127.0.0.1?token=secret"], ["pin": "missing"], ["code": "short"], ["version": 2]] as [[String: Any]] {
            XCTAssertThrowsError(try Pairing.parse(try link(defaults.merging(change) { _, new in new })))
        }
        XCTAssertThrowsError(try Pairing.parse("https://example.com"))
    }
    func testTerminalStatusRequiresActualOutcome() throws {
        func task(_ status: String) throws -> RemoteTask {
            let data = try JSONSerialization.data(withJSONObject: ["id": "x", "backend": "qwen", "project": "p", "request": "work", "status": status, "createdAt": 1, "updatedAt": 1, "activity": "", "output": "", "outputTruncated": false, "permissions": [], "events": []])
            return try JSONDecoder().decode(RemoteTask.self, from: data)
        }
        XCTAssertFalse(try task("cancelling").terminal)
        XCTAssertFalse(try task("waiting").terminal)
        XCTAssertTrue(try task("interrupted").terminal)
        XCTAssertTrue(try task("completed").terminal)
    }

    func testHTTPSAcceptsOnlyThePairedMacCertificate() async throws {
        guard let fixture = Bundle(for: Self.self).url(forResource: "pairing", withExtension: "json"),
              let data = try? Data(contentsOf: fixture),
              let values = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let url = values["url"], let pin = values["pin"], let token = values["token"] else {
            throw XCTSkip("Start the local HTTPS fixture for certificate pinning tests.")
        }
        let state: RemoteState = try await MobileAPI(MacConnection(url: url, pin: pin, token: token, name: "Fixture")).request("v1/state")
        XCTAssertEqual(state.version, 1)
        do {
            let _: RemoteState = try await MobileAPI(MacConnection(url: url, pin: String(repeating: "0", count: 64), token: token, name: "Wrong Mac")).request("v1/state")
            XCTFail("A different certificate must never be accepted")
        } catch {
            XCTAssertFalse(error is MobileFailure, "The wrong pin must fail at TLS, before any HTTP response")
        }
    }

    func testTransportRejectsPlaintextEvenWithLocalATSException() async throws {
        do {
            let _: RemoteState = try await MobileAPI(MacConnection(url: "http://127.0.0.1:1", pin: String(repeating: "0", count: 64), token: "fixture", name: "Invalid")).request("v1/state")
            XCTFail("Plaintext must be rejected before creating a network request")
        } catch MobileFailure.invalidPairing { }
    }
}
