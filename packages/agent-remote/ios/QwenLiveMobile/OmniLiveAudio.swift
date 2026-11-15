import AVFoundation

/// One serial capture stream; independent of microphone hardware for regression tests.
final class OmniPCMEncoder {
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat
    init(inputFormat: AVAudioFormat) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: format) else { throw OmniLiveFailure.audio }
        outputFormat = format; self.converter = converter; converter.primeMethod = .none
    }
    func encode(_ input: AVAudioPCMBuffer) throws -> Data {
        let capacity = AVAudioFrameCount(Double(input.frameLength) * 16_000 / input.format.sampleRate + 32)
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { throw OmniLiveFailure.audio }
        var supplied = false, error: NSError?
        let status = converter.convert(to: output, error: &error) { _, result in
            if supplied { result.pointee = .noDataNow; return nil }
            supplied = true; result.pointee = .haveData; return input
        }
        guard error == nil, status != .error else { throw OmniLiveFailure.audio }
        guard output.frameLength > 0 else { return Data() }
        guard let bytes = output.int16ChannelData?[0] else { throw OmniLiveFailure.audio }
        return Data(bytes: bytes, count: Int(output.frameLength) * 2)
    }
}

private final class OmniCaptureStatistics {
    private let lock = NSLock()
    private var raw = 0, converted = 0, empty = 0
    func input() { lock.lock(); raw += 1; lock.unlock() }
    func output(empty: Bool) { lock.lock(); if empty { self.empty += 1 } else { converted += 1 }; lock.unlock() }
    func snapshot() -> (raw: Int, converted: Int, empty: Int) { lock.lock(); defer { lock.unlock() }; return (raw, converted, empty) }
}

@MainActor final class NativeOmniLiveAudio: OmniLiveAudio {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var captureMixer: AVAudioMixerNode?
    private var tapped = false
    private var ownsSession = false
    private var authorizationID: UUID?
    private var observers: [NSObjectProtocol] = []
    private var onFailure: (() -> Void)?
    private var onInput: ((Data) -> Void)?
    private var captureID: UUID?
    private var configurationObserver: NSObjectProtocol?
    private var configurationChanges = 0
    private var startupRestarts = 0
    private var scheduledPlayback = false
    private var failureCode = "none"
    private var baseFormatDescription = ""
    private var statistics = OmniCaptureStatistics()
    var capturedInputBuffers: Int? { statistics.snapshot().converted }
    var isEngineRunning: Bool? { engine?.isRunning ?? false }
    var formatDescription: String {
        let value = statistics.snapshot()
        return baseFormatDescription + "; raw_buffers=\(value.raw), pcm_buffers=\(value.converted), empty_buffers=\(value.empty)" +
            "; engine_running=\(engine?.isRunning ?? false), config_changes=\(configurationChanges), startup_restarts=\(startupRestarts), failure=\(failureCode)"
    }

    init() {
        for name in [AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                if name == AVAudioSession.interruptionNotification,
                   notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt != AVAudioSession.InterruptionType.began.rawValue { return }
                MainActor.assumeIsolated { self?.fail(name == AVAudioSession.interruptionNotification ? "interruption" : "media_services_reset") }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            guard notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            MainActor.assumeIsolated { self?.fail("route_unavailable") }
        })
    }
    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
    }

    func authorize() async throws {
        let id = UUID(); authorizationID = id
        let granted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard authorizationID == id, !Task.isCancelled else { throw CancellationError() }
        guard granted else { throw OmniLiveFailure.permission }
    }

    func start(onInput: @escaping (Data) -> Void, onFailure: @escaping () -> Void) throws {
        stop(); self.onFailure = onFailure; self.onInput = onInput; statistics = OmniCaptureStatistics()
        baseFormatDescription = "capture_v3"; configurationChanges = 0; startupRestarts = 0; scheduledPlayback = false; failureCode = "none"
        do { try startEngine() }
        catch { failureCode = "start_\((error as NSError).code)"; throw error }
    }

    private func startEngine() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true); ownsSession = true
        let engine = AVAudioEngine(); self.engine = engine
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let self, let source = notification.object as? AVAudioEngine, self.engine === source else { return }
                // Record only. Rebuilding here can deadlock on Core Audio's notification queue.
                self.configurationChanges += 1
            }
        }
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        input.isVoiceProcessingInputMuted = false
        try connectCapture(engine)
    }

    private func connectCapture(_ engine: AVAudioEngine) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        baseFormatDescription = "capture_v3; \(Int(format.sampleRate)) Hz / \(format.channelCount) ch → 16000 Hz PCM16; " +
            AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        guard format.sampleRate > 0, format.channelCount > 0,
              let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1) else { throw OmniLiveFailure.audio }
        let encoder = try OmniPCMEncoder(inputFormat: format), statistics = self.statistics
        let player = AVAudioPlayerNode(); self.player = player
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        // Keep input on the rendered graph while the reply player is idle.
        // The private mixer is silent so microphone audio never loops to the speaker.
        let capture = AVAudioMixerNode(); captureMixer = capture; engine.attach(capture); capture.outputVolume = 0
        engine.connect(input, to: capture, format: format)
        engine.connect(capture, to: engine.mainMixerNode, format: format)
        let id = UUID(); captureID = id
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            statistics.input()
            do {
                let data = try encoder.encode(buffer); statistics.output(empty: data.isEmpty)
                guard !data.isEmpty else { return }
                Task { @MainActor [weak self] in
                    guard let self, self.captureID == id else { return }; self.onInput?(data)
                }
            } catch {
                Task { @MainActor [weak self] in
                    guard let self, self.captureID == id else { return }; self.fail("pcm_conversion")
                }
            }
        }
        tapped = true; engine.prepare(); try engine.start()
        guard self.engine === engine else { engine.stop(); throw CancellationError() }
    }

    func recoverCaptureIfNeeded() throws -> Bool {
        // A startup route/format change may stop an otherwise successfully started engine.
        // Reconnect using its current format, without releasing the active session or replaying audio.
        guard let engine, !engine.isRunning, ownsSession, onInput != nil, startupRestarts == 0,
              statistics.snapshot().raw == 0, !scheduledPlayback else { return false }
        startupRestarts += 1; captureID = nil
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        if let player { engine.detach(player) }
        if let captureMixer { engine.detach(captureMixer) }
        player = nil; captureMixer = nil
        do { try connectCapture(engine); return true }
        catch { failureCode = "restart_\((error as NSError).code)"; throw error }
    }

    private func fail(_ code: String) {
        guard onFailure != nil else { return }
        failureCode = code; onFailure?()
    }

    func play(_ pcm: Data, completed: @escaping () -> Void) throws {
        guard let player, engine?.isRunning == true,
              let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)),
              let samples = buffer.floatChannelData?[0] else { throw OmniLiveFailure.audio }
        buffer.frameLength = buffer.frameCapacity
        pcm.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for i in 0..<Int(buffer.frameLength) {
                let word = UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8
                samples[i] = Float(Int16(bitPattern: word)) / 32768
            }
        }
        scheduledPlayback = true
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in Task { @MainActor in completed() } }
        if !player.isPlaying { player.play() }
    }
    func stopPlayback() { player?.stop() }
    func stop() {
        authorizationID = nil; captureID = nil; onFailure = nil; onInput = nil
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }; configurationObserver = nil
        player?.stop(); engine?.stop()
        if tapped { engine?.inputNode.removeTap(onBus: 0); tapped = false }
        player = nil; captureMixer = nil; engine = nil
        if ownsSession { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); ownsSession = false }
    }
}
