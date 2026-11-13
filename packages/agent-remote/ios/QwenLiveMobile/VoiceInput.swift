import AVFoundation
import Speech
import Combine

enum VoiceInputFailure: LocalizedError {
    case unavailable, permission, interrupted, noInput
    var errorDescription: String? {
        switch self {
        case .unavailable: return tr("dictationUnavailable")
        case .permission: return tr("dictationPermissionDenied")
        case .interrupted: return tr("dictationInterrupted")
        case .noInput: return tr("dictationNoInput")
        }
    }
}

@MainActor
protocol VoiceInputSource: AnyObject {
    func authorize(localeIdentifier: String) async throws
    func start(onText: @escaping (String) -> Void, onEnd: @escaping (Error?) -> Void) throws
    func stop()
}

@MainActor
final class VoiceInputModel: ObservableObject {
    enum Phase { case idle, authorizing, recording }
    @Published private(set) var phase = Phase.idle
    @Published private(set) var transcript = ""
    @Published private(set) var error: String?
    private let source: any VoiceInputSource
    private var operation: UUID?

    init(source: (any VoiceInputSource)? = nil) { self.source = source ?? NativeVoiceInputSource() }

    func start(localeIdentifier: String, onText: @escaping (String) -> Void = { _ in }) async {
        guard phase == .idle else { return }
        let id = UUID(); operation = id; transcript = ""; error = nil; phase = .authorizing
        do {
            try await source.authorize(localeIdentifier: localeIdentifier)
            guard operation == id else { return }
            try Task.checkCancellation()
            phase = .recording
            try source.start(onText: { [weak self] text in
                guard let self, self.operation == id else { return }
                self.transcript = text
                onText(text)
            }, onEnd: { [weak self] error in
                guard let self, self.operation == id else { return }
                self.operation = nil; self.source.stop(); self.phase = .idle
                self.error = error?.localizedDescription
            })
        } catch {
            guard operation == id else { return }
            operation = nil; source.stop(); phase = .idle; self.error = error.localizedDescription
        }
    }

    /// Cancels permission continuations and late recognition callbacks as well
    /// as capture. The caller keeps the partial transcript for review/editing.
    func stop() { operation = nil; source.stop(); phase = .idle }
    func clearError() { error = nil }
}

@MainActor
final class NativeVoiceInputSource: VoiceInputSource {
    private var recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var ownsAudioSession = false
    private var onEnd: ((Error?) -> Void)?
    private var interruptionObserver: NSObjectProtocol?
    private var authorizationID: UUID?

    init() {
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main) { [weak self] notification in
                guard let kind = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      kind == AVAudioSession.InterruptionType.began.rawValue else { return }
                MainActor.assumeIsolated { self?.onEnd?(VoiceInputFailure.interrupted) }
            }
    }
    deinit { if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) } }

    func authorize(localeIdentifier: String) async throws {
        let id = UUID(); authorizationID = id
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
        guard let recognizer, recognizer.supportsOnDeviceRecognition else { throw VoiceInputFailure.unavailable }
        self.recognizer = recognizer
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard authorizationID == id else { throw CancellationError() }
        guard speech == .authorized else { throw VoiceInputFailure.permission }
        try Task.checkCancellation()
        let microphone = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard authorizationID == id else { throw CancellationError() }
        guard microphone else { throw VoiceInputFailure.permission }
    }

    func start(onText: @escaping (String) -> Void, onEnd: @escaping (Error?) -> Void) throws {
        guard let recognizer, recognizer.supportsOnDeviceRecognition else { throw VoiceInputFailure.unavailable }
        stop()
        self.onEnd = onEnd
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        try session.setActive(true)
        ownsAudioSession = true
        let engine = AVAudioEngine(); self.engine = engine
        let request = SFSpeechAudioBufferRecognitionRequest(); self.request = request
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        let node = engine.inputNode, format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceInputFailure.noInput }
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        tapInstalled = true
        recognition = recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString, final = result?.isFinal == true
            Task { @MainActor in
                if let text { onText(text) }
                if final || error != nil { onEnd(error) }
            }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        authorizationID = nil
        onEnd = nil
        engine?.stop()
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio(); recognition?.cancel()
        recognition = nil; request = nil; engine = nil
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsAudioSession = false
        }
    }
}
