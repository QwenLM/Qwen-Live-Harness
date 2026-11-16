import Foundation

struct PersonalFeedState: Decodable {
    let preferences: FeedPreferences
    let status: String
    let error: String?
    let cards: [InsightCard]
    let sources: [InsightSource]
    let lastEvaluatedAt: Double?
    let nextEvaluationAt: Double?
    var working: Bool { status == "collecting" || status == "generating" }
}

struct FeedPreferences: Codable, Equatable {
    var enabled: Bool
    var sources: [String]
    var backend: String
    var language: String

    func matches(_ other: FeedPreferences) -> Bool {
        enabled == other.enabled && Set(sources) == Set(other.sources) && backend == other.backend && language == other.language
    }
}

struct InsightSource: Decodable, Identifiable {
    let id: String
    let enabled: Bool
    let count: Int
    let status: String
}

struct InsightCard: Decodable, Identifiable {
    let id: String
    let kind: String
    let topic: String
    let title: String
    let summary: String
    let why: String
    let sections: [InsightSection]
    let evidence: [InsightEvidence]
    let followUp: String
    let createdAt: Double
    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }
    func favoriteID(computerID: UUID) -> String { "insight." + computerID.uuidString + "." + id }

    /// A new draft, never automatic execution or replay of a historical request.
    var continuationDraft: String {
        ([tr("insightDraftIntro"), title, summary, why] +
         sections.map { $0.label + ": " + $0.text } +
         [tr("insightDraftEvidence")] + evidence.map { "[" + tr("insightRole_" + $0.role) + "] " + $0.quote } +
         [tr("insightDraftQuestion"), followUp]).joined(separator: "\n\n")
    }
}

struct InsightSection: Decodable { let label: String; let text: String }
struct InsightEvidence: Decodable {
    let contextId: String
    let source: String
    let title: String
    let updatedAt: Double
    let role: String
    let quote: String
    let incomplete: Bool
    let link: InsightTaskLink?

    func activityLink(computerID: UUID, contextID: UUID, state: RemoteState?) -> ActivityLink? {
        guard let link else { return nil }
        let result = ActivityLink(computerID: computerID, contextID: contextID, runID: link.runId,
                                  conversationID: link.conversationId, taskID: link.taskId)
        return result.route(computerID: computerID, contextID: contextID, state: state) == nil ? nil : result
    }
}
struct InsightTaskLink: Decodable { let runId: String; let conversationId: String; let taskId: String }
