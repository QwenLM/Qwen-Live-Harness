import Foundation
import Combine

struct OmniLiveCredentials: Decodable {
    let model: String
    let url: String
    let token: String
    let expiresAt: Double
    func validate(now: Date = Date()) throws {
        guard model == "qwen3.8-omni-flash-realtime", let address = URLComponents(string: url),
              address.scheme == "wss", address.user == nil, address.password == nil, address.port == nil, address.fragment == nil,
              address.host?.range(of: #"^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$"#, options: .regularExpression) != nil,
              address.path == "/api-ws/v1/realtime", address.queryItems == [URLQueryItem(name: "model", value: model)],
              token.hasPrefix("st-"), (12...4096).contains(token.utf8.count), token.utf8.allSatisfy({ (33...126).contains($0) }),
              expiresAt > now.timeIntervalSince1970 + 3, expiresAt <= now.timeIntervalSince1970 + 120 else { throw OmniLiveFailure.protocolError }
    }
}

enum OmniLiveFailure: LocalizedError {
    case permission, connection, protocolError, audio, noInput, overloaded, interrupted
    var errorDescription: String? {
        switch self {
        case .permission: return tr("liveMicrophoneDenied")
        case .connection: return tr("liveConnectionFailed")
        case .protocolError: return tr("liveProtocolFailed")
        case .audio: return tr("liveAudioFailed")
        case .noInput: return tr("liveNoMicrophoneData")
        case .overloaded: return tr("liveAudioOverloaded")
        case .interrupted: return tr("liveInterrupted")
        }
    }
}

@MainActor protocol OmniLiveTransport: AnyObject {
    var failureCode: String { get }
    func open(_ credentials: OmniLiveCredentials, onEvent: @escaping ([String: Any]) -> Void, onFailure: @escaping () -> Void)
    func send(_ event: [String: Any]) async throws
    func close()
}
extension OmniLiveTransport { var failureCode: String { "" } }

@MainActor protocol OmniLiveAudio: AnyObject {
    var formatDescription: String { get }
    var capturedInputBuffers: Int? { get }
    var isEngineRunning: Bool? { get }
    func authorize() async throws
    func start(onInput: @escaping (Data) -> Void, onFailure: @escaping () -> Void) throws
    func recoverCaptureIfNeeded() throws -> Bool
    func play(_ pcm: Data, completed: @escaping () -> Void) throws
    func stopPlayback()
    func stop()
}
extension OmniLiveAudio {
    var formatDescription: String { "" }
    var capturedInputBuffers: Int? { nil }
    var isEngineRunning: Bool? { nil }
    func recoverCaptureIfNeeded() throws -> Bool { false }
}

/// A phone-owned conversation. No desktop tools or task mutations are exposed
/// to the model. Credentials, audio and transcripts are memory-only.
@MainActor final class OmniLiveModel: ObservableObject {
    enum Phase: String { case idle, authorizing, connecting, listening, thinking, speaking, ended }
    struct Line: Identifiable { let id: String; let user: Bool; var text: String }
    @Published private(set) var phase = Phase.idle
    @Published private(set) var muted = false
    @Published private(set) var lines: [Line] = []
    @Published private(set) var error: String?
    @Published private(set) var inputLevel = 0.0
    private(set) var inputPackets = 0
    private(set) var uploadedPackets = 0
    private(set) var speechStarts = 0
    private(set) var replyPackets = 0
    private var lastMeterUpdate = Date.distantPast
    private var audioFormat = ""
    private var providerCode = ""
    @Published private var lastStep = "idle"
    private var hasDiagnostics = false
    private var lastSnapshotWrite = Date.distantPast
    var diagnostics: String {
        "model: qwen3.8-omni-flash-realtime\nstate: " + phase.rawValue + "\nlast_step: " + lastStep + "\nmuted: \(muted)" +
        "\ninput_chunks: \(inputPackets)\nsent_chunks: \(uploadedPackets)\nspeech_starts: \(speechStarts)\nreply_audio_chunks: \(replyPackets)" +
        (audioFormat.isEmpty ? "" : "\naudio: " + audioFormat) + (providerCode.isEmpty ? "" : "\nprovider_code: " + providerCode)
    }
    var active: Bool { operation != nil }
    private let audio: any OmniLiveAudio
    private let transport: any OmniLiveTransport
    private var operation: UUID?
    private var connectTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var sending: Task<Void, Never>?
    private var captureMonitor: Task<Void, Never>?
    private let inputStartupTimeout: Duration
    private var queue: [[String: Any]] = []
    private var configured = false
    private var configuring = false
    private var responseID: String?
    private var generating = false
    private var retired: [String] = []
    private var playbackID = UUID()
    private var playbackBytes = 0
    private var eventIDs: [String] = []

    init(audio: (any OmniLiveAudio)? = nil, transport: (any OmniLiveTransport)? = nil, inputStartupTimeout: Duration = .seconds(6)) {
        self.audio = audio ?? NativeOmniLiveAudio(); self.transport = transport ?? NativeOmniLiveTransport()
        self.inputStartupTimeout = inputStartupTimeout
    }

    func start(credentials: @escaping () async throws -> OmniLiveCredentials) {
        guard !active else { return }
        let id = UUID(); operation = id; phase = .authorizing; error = nil; muted = false; lines = []
        configured = false; configuring = false; responseID = nil; generating = false; retired = []; eventIDs = []
        inputPackets = 0; uploadedPackets = 0; speechStarts = 0; replyPackets = 0; inputLevel = 0; audioFormat = ""; providerCode = ""; lastMeterUpdate = .distantPast; lastStep = "microphone_permission"
        hasDiagnostics = true; writeDiagnosticSnapshot(force: true)
        connectTask = Task {
            do {
                try await audio.authorize()
                guard operation == id, !Task.isCancelled else { return }
                phase = .connecting
                lastStep = "temporary_token"
                writeDiagnosticSnapshot(force: true)
                let value = try await credentials()
                guard operation == id, !Task.isCancelled else { return }
                try value.validate()
                lastStep = "websocket"
                writeDiagnosticSnapshot(force: true)
                transport.open(value, onEvent: { [weak self] event in
                    guard let self, self.operation == id else { return }; self.receive(event)
                }, onFailure: { [weak self] in
                    guard let self, self.operation == id else { return }
                    self.providerCode = self.transport.failureCode; self.fail(OmniLiveFailure.connection)
                })
                timeoutTask = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled, let self, self.operation == id, !self.configured else { return }
                    self.fail(OmniLiveFailure.connection)
                }
            } catch {
                guard operation == id else { return }
                fail(error)
            }
        }
    }

    func stop() {
        operation = nil; connectTask?.cancel(); connectTask = nil; timeoutTask?.cancel(); timeoutTask = nil
        sending?.cancel(); sending = nil; queue = []; configured = false; configuring = false
        captureMonitor?.cancel(); captureMonitor = nil
        transport.close(); clearPlayback(); audio.stop(); phase = .ended
        inputLevel = 0
        writeDiagnosticSnapshot(force: true)
    }
    func interrupt() { guard active else { return }; fail(OmniLiveFailure.interrupted) }
    func toggleMute() {
        guard configured else { return }
        muted.toggle()
        if muted { inputLevel = 0 }
        queue.removeAll { $0["type"] as? String == "input_audio_buffer.append" }
        if muted { enqueue(["type": "input_audio_buffer.clear"]) }
        writeDiagnosticSnapshot(force: true)
    }
    private func fail(_ error: Error) {
        if ["audio_device", "streaming", "microphone_no_data", "audio_engine_stopped", "audio_startup_recovery"].contains(lastStep) { audioFormat = audio.formatDescription }
        if let failure = error as? MobileFailure, case let .remote(status, _) = failure { providerCode = "status_\(status)" }
        stop(); self.error = error.localizedDescription
    }
    private func clearPlayback() { playbackID = UUID(); playbackBytes = 0; audio.stopPlayback() }

    private func enqueue(_ event: [String: Any]) {
        guard let id = operation else { return }
        guard queue.count < 64 else { fail(OmniLiveFailure.overloaded); return }
        var value = event; value["event_id"] = UUID().uuidString
        queue.append(value)
        guard sending == nil else { return }
        sending = Task {
            do {
                while operation == id, !Task.isCancelled, !queue.isEmpty {
                    let next = queue.removeFirst()
                    try await transport.send(next)
                    guard operation == id else { return }
                    if next["type"] as? String == "input_audio_buffer.append" { uploadedPackets += 1 }
                    writeDiagnosticSnapshot()
                }
            } catch { if operation == id { providerCode = transport.failureCode; fail(OmniLiveFailure.connection) } }
            if operation == id { sending = nil }
        }
    }

    static var configuration: [String: Any] {
        ["type": "session.update", "session": [
            "modalities": ["text", "audio"],
            "audio": ["input": ["format": ["type": "pcm", "sample_rate": 16000, "sample_format": "s16le", "channels": 1, "packing": "interleaved", "channel_layout": "mono"]],
                      "output": ["voice": "Tina", "format": ["type": "pcm", "sample_rate": 24000]]],
            "input_audio_transcription": ["model": "qwen3-asr-flash-realtime"],
            "turn_detection": ["type": "server_vad", "threshold": 0.5, "silence_duration_ms": 700],
            "instructions": "You are Qwen Omni, the user's personal voice assistant in Agent Remote on iPhone. Converse naturally and briefly in the user's language. You only receive the microphone audio explicitly shared during this call. You cannot see the camera or screen and cannot operate the phone or computer. Do not claim to have completed tasks, saved memory, or accessed files."
        ]]
    }

    private func line(_ id: String, user: Bool, text: String, append: Bool = false) {
        guard !id.isEmpty, id.utf8.count <= 256, text.utf8.count <= 65_536 else { fail(OmniLiveFailure.protocolError); return }
        if let index = lines.firstIndex(where: { $0.id == id && $0.user == user }) {
            lines[index].text = String((append ? lines[index].text + text : text).prefix(16_000))
        } else { lines.append(Line(id: id, user: user, text: String(text.prefix(16_000)))) }
        if lines.count > 200 { lines.removeFirst(lines.count - 200) }
    }

    private func receive(_ event: [String: Any]) {
        let before = phase
        defer { writeDiagnosticSnapshot(force: phase != before) }
        if let id = event["event_id"] as? String {
            guard id.utf8.count <= 256 else { fail(OmniLiveFailure.protocolError); return }
            if eventIDs.contains(id) { return }
            eventIDs.append(id); if eventIDs.count > 512 { eventIDs.removeFirst() }
        }
        guard let type = event["type"] as? String else { fail(OmniLiveFailure.protocolError); return }
        if type == "session.created" {
            guard !configuring else { return }; configuring = true; lastStep = "session_configuration"; enqueue(Self.configuration); return
        }
        if type == "error" {
            if let detail = event["error"] as? [String: Any], let code = detail["code"] as? String,
               code.range(of: #"^[A-Za-z0-9_.-]{1,64}$"#, options: .regularExpression) != nil,
               !code.contains("sk-"), !code.contains("st-") { providerCode = code }
            fail(OmniLiveFailure.protocolError); return
        }
        if type == "session.updated" {
            guard configuring, !configured, let id = operation else { return }
            configured = true; timeoutTask?.cancel(); timeoutTask = nil
            lastStep = "audio_device"
            do {
                try audio.start(onInput: { [weak self] data in
                    guard let self, self.operation == id, self.configured, !self.muted else { return }
                    guard !data.isEmpty, data.count <= 64 * 1024, data.count % 2 == 0 else { self.fail(OmniLiveFailure.audio); return }
                    self.inputPackets += 1
                    if Date().timeIntervalSince(self.lastMeterUpdate) >= 0.125 {
                        self.lastMeterUpdate = Date(); self.inputLevel = Self.level(data)
                    }
                    self.enqueue(["type": "input_audio_buffer.append", "audio": data.base64EncodedString()])
                    self.writeDiagnosticSnapshot()
                }, onFailure: { [weak self] in
                    guard let self, self.operation == id else { return }; self.fail(OmniLiveFailure.audio)
                })
                guard operation == id, configured else { return }
                audioFormat = audio.formatDescription
                lastStep = "streaming"
                phase = .listening
                monitorCapture(id)
            } catch { if operation == id { fail(OmniLiveFailure.audio) } }
            return
        }
        guard configured else { return }
        switch type {
        case "input_audio_buffer.speech_started":
            speechStarts += 1
            if let responseID, generating { enqueue(["type": "response.cancel"]); retire(responseID) }
            else if let responseID { retire(responseID) }
            responseID = nil; generating = false; clearPlayback(); phase = .listening
        case "input_audio_buffer.speech_stopped": phase = .thinking
        case "conversation.item.input_audio_transcription.delta":
            if let id = event["item_id"] as? String { line(id, user: true, text: (event["text"] as? String ?? "") + (event["stash"] as? String ?? "")) }
        case "conversation.item.input_audio_transcription.completed":
            if let id = event["item_id"] as? String, let text = event["transcript"] as? String { line(id, user: true, text: text) }
        case "response.created":
            guard let response = event["response"] as? [String: Any], let id = response["id"] as? String,
                  !id.isEmpty, id.utf8.count <= 256, !retired.contains(id), id != responseID else { return }
            if let previous = responseID { retire(previous) }
            clearPlayback(); responseID = id; generating = true; phase = .thinking
        case "response.audio.delta":
            guard generating, event["response_id"] as? String == responseID, let encoded = event["delta"] as? String else { return }
            guard encoded.utf8.count <= 350_000, let data = Data(base64Encoded: encoded), !data.isEmpty,
                  data.count % 2 == 0, data.count <= 256 * 1024, playbackBytes + data.count <= 24_000 * 2 * 30 else { fail(OmniLiveFailure.overloaded); return }
            playbackBytes += data.count; phase = .speaking
            replyPackets += 1
            let epoch = playbackID, operation = self.operation
            do {
                try audio.play(data) { [weak self] in
                    guard let self, self.operation == operation, self.playbackID == epoch else { return }
                    self.playbackBytes -= data.count
                    if self.playbackBytes == 0, !self.generating { self.phase = .listening; self.writeDiagnosticSnapshot(force: true) }
                }
            } catch { fail(OmniLiveFailure.audio) }
        case "response.audio_transcript.delta", "response.text.delta":
            if event["response_id"] as? String == responseID, let id = responseID, let text = event["delta"] as? String { line(id, user: false, text: text, append: true) }
        case "response.audio_transcript.done", "response.text.done":
            if event["response_id"] as? String == responseID, let id = responseID, let text = (event["transcript"] ?? event["text"]) as? String { line(id, user: false, text: text) }
        case "response.done":
            guard responseID != nil, let response = event["response"] as? [String: Any], response["id"] as? String == responseID else { return }
            generating = false
            if response["status"] as? String == "failed" { fail(OmniLiveFailure.protocolError) }
            else if playbackBytes == 0 { phase = .listening }
        default: break
        }
    }
    private func retire(_ id: String) { retired.append(id); if retired.count > 256 { retired.removeFirst() } }
    private func monitorCapture(_ id: UUID) {
        let deadline = ContinuousClock.now.advanced(by: inputStartupTimeout)
        captureMonitor = Task { [weak self] in
            var attemptedRecovery = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, let self, self.operation == id else { return }
                self.audioFormat = self.audio.formatDescription; self.writeDiagnosticSnapshot()
                if self.audio.isEngineRunning == false {
                    if !attemptedRecovery, self.inputPackets == 0, self.replyPackets == 0, !self.generating, ContinuousClock.now < deadline {
                        attemptedRecovery = true; self.lastStep = "audio_startup_recovery"
                        do {
                            if try self.audio.recoverCaptureIfNeeded() { continue }
                        } catch { self.fail(OmniLiveFailure.audio); return }
                    }
                    self.lastStep = "audio_engine_stopped"; self.fail(OmniLiveFailure.audio); return
                }
                if self.lastStep == "audio_startup_recovery" { self.lastStep = "streaming" }
                if ContinuousClock.now >= deadline, self.audio.capturedInputBuffers == 0 {
                    self.lastStep = "microphone_no_data"; self.fail(OmniLiveFailure.noInput); return
                }
            }
        }
    }
    static func level(_ pcm: Data) -> Double {
        var peak = 0.0
        pcm.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for index in stride(from: 0, to: bytes.count - 1, by: 2) {
                let word = UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8
                peak = max(peak, abs(Double(Int16(bitPattern: word))) / 32768)
            }
        }
        return min(1, peak * 4)
    }
    private func writeDiagnosticSnapshot(force: Bool = false) {
        #if DEBUG
        // Developer diagnostics only. Fixed fields exclude credentials, URLs,
        // transcripts and audio. Never export the app's actual configuration.
        guard hasDiagnostics, force || Date().timeIntervalSince(lastSnapshotWrite) >= 1 else { return }
        lastSnapshotWrite = Date()
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let text = "updated_at: " + ISO8601DateFormatter().string(from: Date()) + "\n" + diagnostics
            try Data(text.utf8).write(to: directory.appendingPathComponent("omni-live-diagnostics-v1.txt"), options: [.atomic, .completeFileProtection])
        } catch { /* A diagnostic write never affects the call. */ }
        #endif
    }
}

@MainActor final class NativeOmniLiveTransport: OmniLiveTransport {
    private(set) var failureCode = ""
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var receiving: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    func open(_ credentials: OmniLiveCredentials, onEvent: @escaping ([String: Any]) -> Void, onFailure: @escaping () -> Void) {
        close(); failureCode = ""
        var request = URLRequest(url: URL(string: credentials.url)!)
        request.setValue("Bearer " + credentials.token, forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        let session = URLSession(configuration: configuration)
        self.session = session
        let socket = session.webSocketTask(with: request); socket.maximumMessageSize = 1_024 * 1_024
        self.socket = socket; socket.resume()
        receiving = Task {
            do {
                while !Task.isCancelled, self.socket === socket {
                    let message = try await socket.receive()
                    guard !Task.isCancelled, self.socket === socket else { return }
                    let data: Data
                    switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: throw OmniLiveFailure.protocolError }
                    guard data.count <= 1_024 * 1_024, let event = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw OmniLiveFailure.protocolError }
                    onEvent(event)
                }
            } catch { if !Task.isCancelled, self.socket === socket { recordFailure(error, socket: socket); onFailure() } }
        }
        heartbeat = Task {
            do {
                while !Task.isCancelled, self.socket === socket {
                    try await Task.sleep(for: .seconds(15))
                    try Task.checkCancellation()
                    try await Self.ping(socket)
                }
            } catch { if !Task.isCancelled, self.socket === socket { recordFailure(error, socket: socket); onFailure() } }
        }
    }
    private static func ping(_ socket: URLSessionWebSocketTask) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var completed = false
            let timeout = Task { @MainActor in
                try? await Task.sleep(for: .seconds(8))
                guard !Task.isCancelled, !completed else { return }
                completed = true; continuation.resume(throwing: OmniLiveFailure.connection)
            }
            socket.sendPing { error in
                Task { @MainActor in
                    guard !completed else { return }
                    completed = true; timeout.cancel()
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        }
    }
    func send(_ event: [String: Any]) async throws {
        guard let socket else { throw OmniLiveFailure.connection }
        let data = try JSONSerialization.data(withJSONObject: event)
        guard data.count <= 128 * 1024, let text = String(data: data, encoding: .utf8) else { throw OmniLiveFailure.protocolError }
        do { try await socket.send(.string(text)) }
        catch { recordFailure(error, socket: socket); throw error }
    }
    private func recordFailure(_ error: Error, socket: URLSessionWebSocketTask) {
        guard self.socket === socket else { return }
        if let response = socket.response as? HTTPURLResponse, response.statusCode >= 400 { failureCode = "HTTP_\(response.statusCode)" }
        else { failureCode = "URLSession_\((error as NSError).code)" }
    }
    func close() {
        receiving?.cancel(); receiving = nil
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
    }
}
