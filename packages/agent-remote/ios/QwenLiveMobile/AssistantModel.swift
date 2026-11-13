import Foundation
import Combine

struct AssistantInput: Codable, Identifiable, Equatable {
    enum Source: String, Codable { case text, voice }
    let id: UUID
    let text: String
    let createdAt: Date
    let source: Source
}

enum MobileAppearance: String, Codable, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { tr("appearance_" + rawValue) }
}

enum DictationLanguage: String, Codable, CaseIterable, Identifiable {
    case system, chinese, english
    var id: String { rawValue }
    var label: String { tr("dictation_" + rawValue) }
    var localeIdentifier: String {
        switch self {
        case .system: return Locale.current.identifier
        case .chinese: return "zh-CN"
        case .english: return "en-US"
        }
    }
}

/// Device-local capture only. Nothing here claims an assistant reply, a memory,
/// a server receipt, or permission to execute a task on a computer.
@MainActor
final class AssistantModel: ObservableObject {
    static let storageKey = "assistantLocalState.v1"
    private struct Snapshot: Codable {
        var version = 1
        var draft = ""
        var inputs: [AssistantInput] = []
        var favorites: Set<String> = []
        var appearance = MobileAppearance.system
        var dictationLanguage = DictationLanguage.system
    }

    @Published var draft = "" { didSet { persist() } }
    @Published private(set) var inputs: [AssistantInput] = []
    @Published private(set) var favorites: Set<String> = []
    @Published var appearance = MobileAppearance.system { didSet { persist() } }
    @Published var dictationLanguage = DictationLanguage.system { didSet { persist() } }
    @Published private(set) var error: String?
    private let defaults: UserDefaults
    private var restoring = true
    private var canWrite = true

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--uitesting") {
            defaults.removeObject(forKey: Self.storageKey)
        }
        #endif
        if let data = defaults.data(forKey: Self.storageKey) {
            do {
                let saved = try JSONDecoder().decode(Snapshot.self, from: data)
                guard saved.version == 1, Set(saved.inputs.map(\.id)).count == saved.inputs.count else {
                    throw MobileFailure.invalidResponse
                }
                draft = saved.draft; inputs = saved.inputs; favorites = saved.favorites
                appearance = saved.appearance; dictationLanguage = saved.dictationLanguage
            } catch {
                // Preserve unreadable data instead of replacing it with an empty list.
                canWrite = false; self.error = tr("assistantStorageUnreadable")
            }
        }
        restoring = false
    }

    @discardableResult
    func saveInput(source: AssistantInput.Source) -> AssistantInput? {
        guard canWrite else { return nil }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        guard text.count <= 20_000, inputs.count < 500 else {
            error = tr(text.count > 20_000 ? "assistantInputTooLong" : "assistantStorageFull"); return nil
        }
        let input = AssistantInput(id: UUID(), text: text, createdAt: Date(), source: source)
        let next = [input] + inputs
        guard write(inputs: next, draft: "") else { return nil }
        restoring = true; inputs = next; draft = ""; restoring = false
        error = nil
        return input
    }

    func deleteInput(_ id: UUID) {
        let next = inputs.filter { $0.id != id }
        guard write(inputs: next, draft: draft) else { return }
        inputs = next
    }

    func toggleFavorite(_ id: String) {
        var next = favorites
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        guard write(inputs: inputs, draft: draft, favorites: next) else { return }
        favorites = next
    }

    func input(_ id: UUID) -> AssistantInput? { inputs.first { $0.id == id } }

    private func persist() {
        guard !restoring else { return }
        _ = write(inputs: inputs, draft: draft)
    }

    private func write(inputs: [AssistantInput], draft: String, favorites: Set<String>? = nil) -> Bool {
        guard canWrite else { return false }
        do {
            let saved = Snapshot(draft: draft, inputs: inputs, favorites: favorites ?? self.favorites,
                                 appearance: appearance, dictationLanguage: dictationLanguage)
            defaults.set(try JSONEncoder().encode(saved), forKey: Self.storageKey)
            return true
        } catch { self.error = tr("assistantStorageFailed"); return false }
    }
}

struct ActivityLink: Hashable {
    let computerID: UUID
    let contextID: UUID
    let runID: String
    let conversationID: String
    let taskID: String

    var id: String {
        [computerID.uuidString, runID, conversationID, taskID]
            .map { Data($0.utf8).base64EncodedString() }.joined(separator: ".")
    }

    func route(computerID: UUID?, contextID: UUID, state: RemoteState?) -> ConversationRoute? {
        guard computerID == self.computerID, contextID == self.contextID, let state, state.runId == runID,
              state.conversations.contains(where: { $0.id == conversationID && $0.turns.contains(where: { $0.id == taskID }) }) else { return nil }
        return ConversationRoute(contextID: contextID, conversationID: conversationID, runID: runID)
    }
}

struct PersonalActivity: Identifiable {
    enum Content {
        case input(AssistantInput)
        case task(RemoteTask)
        case artifact(RemoteArtifact, RemoteTask)
    }
    let id: String
    let title: String
    let summary: String
    let date: Date
    let link: ActivityLink?
    let content: Content

    var symbol: String {
        switch content {
        case .input: return "tray"
        case .task(let task): return task.status == "completed" ? "checkmark" : task.terminal ? "exclamationmark" : "clock"
        case .artifact(let artifact, _): return artifact.kind == "image" ? "photo" : artifact.kind == "html" ? "globe" : "doc.text"
        }
    }
    var category: String {
        switch content {
        case .input: return tr("assistantSavedInput")
        case .task(let task): return tr(task.status)
        case .artifact: return tr("artifacts")
        }
    }

    static func recent(state: RemoteState?, computerID: UUID?, contextID: UUID, inputs: [AssistantInput]) -> [Self] {
        let remote = taskActivities(state: state, computerID: computerID, contextID: contextID)
        return sorted(remote + inputs.map(local)).prefix(3).map { $0 }
    }

    static func feed(state: RemoteState?, computerID: UUID?, contextID: UUID, inputs: [AssistantInput]) -> [Self] {
        var items = inputs.map(local)
        if let state, let computerID {
            for conversation in state.conversations {
                var foundArtifact = false
                for task in conversation.turns {
                    let link = ActivityLink(computerID: computerID, contextID: contextID, runID: state.runId,
                                            conversationID: conversation.id, taskID: task.id)
                    for artifact in task.artifacts ?? [] {
                        foundArtifact = true
                        items.append(Self(id: link.id + "." + Data(artifact.id.utf8).base64EncodedString(), title: artifact.name,
                                          summary: conversation.first.request, date: date(task), link: link, content: .artifact(artifact, task)))
                    }
                }
                let task = conversation.latest
                if !foundArtifact && task.terminal {
                    let link = ActivityLink(computerID: computerID, contextID: contextID, runID: state.runId,
                                            conversationID: conversation.id, taskID: task.id)
                    items.append(Self(id: link.id, title: conversation.first.request, summary: summary(task),
                                      date: date(task), link: link, content: .task(task)))
                }
            }
        }
        return sorted(items)
    }

    private static func taskActivities(state: RemoteState?, computerID: UUID?, contextID: UUID) -> [Self] {
        guard let state, let computerID else { return [] }
        return state.conversations.map { conversation in
            let task = conversation.latest
            let link = ActivityLink(computerID: computerID, contextID: contextID, runID: state.runId,
                                    conversationID: conversation.id, taskID: task.id)
            return Self(id: link.id, title: conversation.first.request, summary: summary(task),
                        date: date(task), link: link, content: .task(task))
        }
    }
    private static func local(_ input: AssistantInput) -> Self {
        Self(id: "input." + input.id.uuidString, title: input.text, summary: tr("assistantInputPendingSummary"),
             date: input.createdAt, link: nil, content: .input(input))
    }
    private static func date(_ task: RemoteTask) -> Date { Date(timeIntervalSince1970: task.updatedAt / 1000) }
    private static func summary(_ task: RemoteTask) -> String {
        let text = (task.terminal ? task.output : task.activity).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? tr(task.status) : String(text.prefix(180))
    }
    private static func sorted(_ items: [Self]) -> [Self] {
        items.sorted { $0.date == $1.date ? $0.id < $1.id : $0.date > $1.date }
    }
}
