import XCTest
import Security
import AVFoundation
@testable import QwenLiveMobile

@MainActor private final class LiveTestAudio: OmniLiveAudio {
    var authorizeAction: (() async throws -> Void)?
    var starts = 0, stops = 0, played: [Data] = []
    var input: ((Data) -> Void)?
    var failure: (() -> Void)?
    var completions: [() -> Void] = []
    var capturedInputBuffers: Int?
    var isEngineRunning: Bool?
    var recoveryAction: (() throws -> Bool)?
    var startAction: (() -> Void)?
    var recoveries = 0
    func authorize() async throws { try await authorizeAction?() }
    func start(onInput: @escaping (Data) -> Void, onFailure: @escaping () -> Void) throws { starts += 1; input = onInput; failure = onFailure; startAction?() }
    func recoverCaptureIfNeeded() throws -> Bool { recoveries += 1; return try recoveryAction?() ?? false }
    func play(_ pcm: Data, completed: @escaping () -> Void) throws { played.append(pcm); completions.append(completed) }
    func stopPlayback() {}
    func stop() { stops += 1 }
}
@MainActor private final class LiveTestTransport: OmniLiveTransport {
    var opens = 0, closes = 0, sent: [[String: Any]] = []
    var event: (([String: Any]) -> Void)?
    var failure: (() -> Void)?
    func open(_ credentials: OmniLiveCredentials, onEvent: @escaping ([String: Any]) -> Void, onFailure: @escaping () -> Void) { opens += 1; event = onEvent; failure = onFailure }
    func send(_ event: [String: Any]) async throws { sent.append(event) }
    func close() { closes += 1 }
}

@MainActor final class OmniLiveTests: XCTestCase {
    private func credentials(url: String? = nil, token: String = "st-test_ephemeral_token", expiry: Double? = nil) -> OmniLiveCredentials {
        OmniLiveCredentials(model: "qwen3.8-omni-flash-realtime", url: url ?? "wss://test-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime", token: token, expiresAt: expiry ?? Date().timeIntervalSince1970 + 60)
    }
    private func settle() async { for _ in 0..<50 { await Task.yield() } }
    private func ready(_ model: OmniLiveModel, _ transport: LiveTestTransport) async {
        model.start { self.credentials() }; await settle()
        transport.event?(["type": "session.created"]); await settle()
        transport.event?(["type": "session.updated"]); await settle()
    }

    func testAudioStartsOnlyAfterSessionAcknowledgementAndPlaybackCompletionControlsStatus() async throws {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        defer { model.stop() }
        model.start { self.credentials() }; await settle()
        XCTAssertEqual(transport.opens, 1); XCTAssertEqual(audio.starts, 0)
        transport.event?(["type": "session.updated"]); XCTAssertEqual(audio.starts, 0)
        transport.event?(["type": "session.created"]); await settle()
        XCTAssertEqual(transport.sent.first?["type"] as? String, "session.update")
        let configuration = try XCTUnwrap(transport.sent.first?["session"] as? [String: Any])
        XCTAssertNil(configuration["tools"]); XCTAssertEqual(configuration["modalities"] as? [String], ["text", "audio"])
        transport.event?(["type": "session.updated"]); transport.event?(["type": "session.updated"])
        XCTAssertEqual(audio.starts, 1); XCTAssertEqual(model.phase, .listening)
        let pcm = Data([0, 0, 1, 0])
        audio.input?(pcm); await settle()
        XCTAssertEqual(model.inputPackets, 1); XCTAssertEqual(model.uploadedPackets, 1)
        XCTAssertFalse(model.diagnostics.contains("st-test_ephemeral_token"))
        XCTAssertEqual(transport.sent.last?["audio"] as? String, pcm.base64EncodedString())
        transport.event?(["type": "conversation.item.input_audio_transcription.completed", "item_id": "question", "transcript": "Hello"])
        transport.event?(["type": "response.created", "response": ["id": "reply"]])
        let chunk: [String: Any] = ["type": "response.audio.delta", "event_id": "audio-1", "response_id": "reply", "delta": pcm.base64EncodedString()]
        transport.event?(chunk); transport.event?(chunk)
        transport.event?(["type": "response.audio_transcript.delta", "response_id": "reply", "delta": "Hi"])
        transport.event?(["type": "response.done", "response": ["id": "reply", "status": "completed"]])
        XCTAssertEqual(audio.played, [pcm], "Duplicate events must not replay audio")
        XCTAssertEqual(model.replyPackets, 1)
        XCTAssertEqual(model.lines.map(\.text), ["Hello", "Hi"])
        XCTAssertFalse(model.diagnostics.contains("Hello"), "Diagnostics must not include conversation content")
        XCTAssertEqual(model.phase, .speaking, "Generation finishing is not a playback receipt")
        audio.completions[0](); XCTAssertEqual(model.phase, .listening)
        model.stop()
        #if DEBUG
        let snapshotURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("omni-live-diagnostics-v1.txt")
        let snapshot = try String(contentsOf: snapshotURL, encoding: .utf8)
        XCTAssertTrue(snapshot.contains("sent_chunks: 1")); XCTAssertTrue(snapshot.contains("reply_audio_chunks: 1"))
        XCTAssertFalse(snapshot.contains("st-test_ephemeral_token")); XCTAssertFalse(snapshot.contains("Hello"))
        #endif
    }

    func testMuteHangupAndOldSessionCallbacksCannotUploadOrResumePlayback() async {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        await ready(model, transport)
        model.toggleMute(); await settle()
        XCTAssertTrue(model.muted); XCTAssertEqual(transport.sent.last?["type"] as? String, "input_audio_buffer.clear")
        let count = transport.sent.count
        audio.input?(Data([0, 0])); await settle(); XCTAssertEqual(transport.sent.count, count)
        model.toggleMute(); audio.input?(Data([0, 0])); await settle(); XCTAssertEqual(transport.sent.count, count + 1)
        let lateEvent = transport.event, lateAudio = audio.input
        model.stop(); lateAudio?(Data([0, 0])); lateEvent?(["type": "session.updated"]); await settle()
        XCTAssertEqual(model.phase, .ended); XCTAssertEqual(audio.starts, 1); XCTAssertEqual(transport.sent.count, count + 1)
        model.start { self.credentials() }; await settle()
        lateEvent?(["type": "error"]); XCTAssertNil(model.error); XCTAssertEqual(model.phase, .connecting)
        model.stop()
    }

    func testPermissionCancellationAndInvalidCredentialsNeverOpenASocket() async {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        var reply: CheckedContinuation<Void, Never>?
        audio.authorizeAction = { await withCheckedContinuation { reply = $0 } }
        var requests = 0
        model.start { requests += 1; return self.credentials() }; await settle()
        model.stop(); reply?.resume(); await settle()
        XCTAssertEqual(requests, 0); XCTAssertEqual(transport.opens, 0)
        audio.authorizeAction = nil
        model.start { self.credentials(token: "sk-permanent-key-must-not-be-used-here") }; await settle()
        XCTAssertEqual(transport.opens, 0); XCTAssertEqual(model.phase, .ended); XCTAssertNotNil(model.error)
    }

    func testBargeInDiscardsOldResponseAudioAndLatePlaybackReceipts() async {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        defer { model.stop() }; await ready(model, transport)
        transport.event?(["type": "response.created", "response": ["id": "old"]])
        let chunk: [String: Any] = ["type": "response.audio.delta", "response_id": "old", "delta": Data([0, 0]).base64EncodedString()]
        transport.event?(chunk)
        transport.event?(["type": "input_audio_buffer.speech_started"]); await settle()
        XCTAssertEqual(transport.sent.last?["type"] as? String, "response.cancel")
        transport.event?(chunk); transport.event?(["type": "response.created", "response": ["id": "old"]])
        transport.event?(["type": "response.created", "response": ["id": "new"]])
        audio.completions[0](); XCTAssertEqual(model.phase, .thinking); XCTAssertEqual(audio.played.count, 1)
    }

    func testFailuresAndMalformedAudioReleaseOwnedResources() async {
        for kind in ["provider", "transport", "audio", "oversized"] {
            let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
            await ready(model, transport)
            switch kind {
            case "provider": transport.event?(["type": "error", "error": ["message": "never echo provider secrets"]])
            case "transport": transport.failure?()
            case "audio": audio.failure?()
            default: audio.input?(Data(repeating: 0, count: 65_538))
            }
            XCTAssertFalse(model.active); XCTAssertEqual(model.phase, .ended); XCTAssertNotNil(model.error)
            XCTAssertFalse(model.error?.contains("secrets") ?? true); XCTAssertGreaterThan(audio.stops, 0); XCTAssertGreaterThan(transport.closes, 0)
        }
    }

    func testCredentialValidationRejectsOtherHostsExpiredKeysRedirectsAndExtraParameters() throws {
        XCTAssertNoThrow(try credentials().validate())
        XCTAssertNoThrow(try credentials(token: "st-opaque+base64/token==").validate(), "Provider-issued credentials are opaque, not URL-safe identifiers")
        XCTAssertThrowsError(try credentials(token: "st-invalid\r\nInjected: value").validate())
        for url in ["wss://evil.example/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime", "ws://test-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime", "wss://test-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime&redirect=evil"] { XCTAssertThrowsError(try credentials(url: url).validate()) }
        XCTAssertThrowsError(try credentials(expiry: Date().timeIntervalSince1970 - 1).validate())
    }
    func testMicrophoneLevelDecodesLittleEndianPCMWithoutSendingAnyAudio() {
        XCTAssertEqual(OmniLiveModel.level(Data(repeating: 0, count: 3200)), 0)
        XCTAssertEqual(OmniLiveModel.level(Data([0, 0x20, 0, 0xe0])), 1)
        XCTAssertEqual(OmniLiveModel.level(Data()), 0)
    }
    func testActualPCMConverterProducesMono16kSamplesFrom48kMicrophoneBuffers() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let encoder = try OmniPCMEncoder(inputFormat: format)
        var encoded = Data()
        for chunk in 0..<12 {
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)); buffer.frameLength = 1024
            let samples = try XCTUnwrap(buffer.floatChannelData?[0])
            for frame in 0..<1024 { samples[frame] = Float(sin(Double(chunk * 1024 + frame) * 440 * 2 * .pi / 48_000) * 0.25) }
            encoded.append(try encoder.encode(buffer))
        }
        XCTAssertGreaterThan(encoded.count, 12 * 1024 / 3 * 2 - 128)
        XCTAssertLessThanOrEqual(encoded.count, 12 * 1024 / 3 * 2 + 128)
        XCTAssertGreaterThan(OmniLiveModel.level(encoded), 0.5)
    }
    func testConnectedCallWithoutMicrophoneBuffersEndsInsteadOfPretendingToListen() async throws {
        let audio = LiveTestAudio(), transport = LiveTestTransport()
        audio.capturedInputBuffers = 0
        let model = OmniLiveModel(audio: audio, transport: transport, inputStartupTimeout: .zero)
        await ready(model, transport)
        for _ in 0..<100 { if !model.active { break }; try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertFalse(model.active); XCTAssertEqual(model.phase, .ended); XCTAssertNotNil(model.error)
        XCTAssertTrue(model.diagnostics.contains("microphone_no_data")); XCTAssertGreaterThan(audio.stops, 0)
    }

    private func waitForCaptureCheck(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Capture monitor did not reach the expected state")
    }

    func testStoppedStartupEngineRecoversOnceWithoutReopeningTransportOrReplayingAudio() async throws {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        defer { model.stop() }
        audio.isEngineRunning = false; audio.capturedInputBuffers = 0
        audio.recoveryAction = { audio.isEngineRunning = true; return true }
        await ready(model, transport)
        try await waitForCaptureCheck { audio.recoveries == 1 }
        XCTAssertTrue(model.active); XCTAssertNil(model.error); XCTAssertEqual(transport.opens, 1)
        XCTAssertEqual(audio.starts, 1); XCTAssertTrue(audio.played.isEmpty)
        let pcm = Data([0, 0, 1, 0]); audio.input?(pcm); await settle()
        XCTAssertEqual(model.inputPackets, 1); XCTAssertEqual(model.uploadedPackets, 1)
        XCTAssertEqual(transport.sent.filter { $0["type"] as? String == "input_audio_buffer.append" }.count, 1)
        audio.isEngineRunning = false
        try await waitForCaptureCheck { !model.active }
        XCTAssertEqual(audio.recoveries, 1); XCTAssertNotNil(model.error)
        XCTAssertTrue(model.diagnostics.contains("audio_engine_stopped"))
    }

    func testRepeatedStartupEngineStopDoesNotLoopRecoveryOrExtendCaptureDeadline() async throws {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        audio.isEngineRunning = false; audio.capturedInputBuffers = 0; audio.recoveryAction = { true }
        await ready(model, transport)
        try await waitForCaptureCheck { !model.active }
        XCTAssertEqual(audio.recoveries, 1); XCTAssertEqual(audio.starts, 1); XCTAssertEqual(transport.opens, 1)
        XCTAssertNotNil(model.error); XCTAssertGreaterThan(audio.stops, 0); XCTAssertGreaterThan(transport.closes, 0)

        let expiredAudio = LiveTestAudio(), expiredTransport = LiveTestTransport()
        expiredAudio.isEngineRunning = false; expiredAudio.capturedInputBuffers = 0
        let expired = OmniLiveModel(audio: expiredAudio, transport: expiredTransport, inputStartupTimeout: .zero)
        await ready(expired, expiredTransport)
        try await waitForCaptureCheck { !expired.active }
        XCTAssertEqual(expiredAudio.recoveries, 0)
    }

    func testStartupRecoveryRefusalAndFailureReleaseResources() async throws {
        for throwsError in [false, true] {
            let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
            audio.isEngineRunning = false
            audio.recoveryAction = { if throwsError { throw OmniLiveFailure.audio }; return false }
            await ready(model, transport)
            try await waitForCaptureCheck { !model.active }
            XCTAssertEqual(audio.recoveries, 1); XCTAssertNotNil(model.error)
            XCTAssertGreaterThan(audio.stops, 0); XCTAssertGreaterThan(transport.closes, 0)
        }
    }

    func testEngineStopAfterInputOrResponseNeverRetriesOrReplays() async throws {
        for stage in ["input", "generating", "playback"] {
            let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
            audio.isEngineRunning = true
            await ready(model, transport)
            if stage == "input" { audio.input?(Data([0, 0])); await settle() }
            else {
                transport.event?(["type": "response.created", "response": ["id": "reply"]])
                if stage == "playback" {
                    transport.event?(["type": "response.audio.delta", "response_id": "reply", "delta": Data([0, 0]).base64EncodedString()])
                }
            }
            audio.isEngineRunning = false
            try await waitForCaptureCheck { !model.active }
            XCTAssertEqual(audio.recoveries, 0); XCTAssertEqual(transport.opens, 1)
            XCTAssertEqual(audio.played.count, stage == "playback" ? 1 : 0)
        }
    }

    func testCancelledCaptureMonitorCannotRecoverOrEndANewSession() async throws {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        audio.isEngineRunning = false
        await ready(model, transport)
        model.stop(); model.start { self.credentials() }; await settle()
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(audio.recoveries, 0); XCTAssertEqual(audio.starts, 1)
        XCTAssertTrue(model.active); XCTAssertNil(model.error); XCTAssertEqual(model.phase, .connecting)
        model.stop()
    }

    func testFailureDuringAudioStartCannotRestoreListeningAfterResourcesAreReleased() async {
        let audio = LiveTestAudio(), transport = LiveTestTransport(), model = OmniLiveModel(audio: audio, transport: transport)
        audio.startAction = { audio.failure?() }
        await ready(model, transport)
        XCTAssertFalse(model.active); XCTAssertEqual(model.phase, .ended); XCTAssertNotNil(model.error)
        XCTAssertEqual(audio.recoveries, 0); XCTAssertGreaterThan(audio.stops, 0); XCTAssertGreaterThan(transport.closes, 0)
    }

    func testKeychainConfigurationSurvivesReopenPreservesSavedKeyAndDeletesOnlyItsOwnRecord() throws {
        let store = OmniLiveKeychain(service: "com.agentremote.tests.omni." + UUID().uuidString)
        defer { try? store.delete() }
        let settings = OmniLiveSettings(storage: store)
        XCTAssertFalse(settings.configured)
        XCTAssertTrue(settings.save(apiKey: "sk-fake-unit-test-key", workspace: "test-workspace", region: "cn-beijing"))
        let reopened = OmniLiveSettings(storage: store)
        XCTAssertTrue(reopened.configured); XCTAssertEqual(reopened.workspace, "test-workspace")
        XCTAssertTrue(reopened.save(apiKey: "", workspace: "second-workspace", region: "ap-southeast-1"))
        XCTAssertEqual(try store.load()?.apiKey, "sk-fake-unit-test-key")
        XCTAssertFalse(reopened.save(apiKey: "invalid", workspace: "evil.example/path", region: "cn-beijing"))
        XCTAssertEqual(try store.load()?.workspace, "second-workspace")
        var attributes: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: store.service,
            kSecReturnAttributes as String: true] as CFDictionary, &attributes), errSecSuccess)
        XCTAssertEqual((attributes as? [String: Any])?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        reopened.delete(); XCTAssertFalse(reopened.configured); XCTAssertNil(try store.load())
    }
}
