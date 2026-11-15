import XCTest
import WebKit
import SwiftUI
@testable import QwenLiveMobile

final class ArtifactTests: XCTestCase {
    @MainActor func testThemeUsesSystemBackgroundsAndAnAdaptiveGreenAccent() throws {
        let accent = try XCTUnwrap(UIColor(named: "AccentColor"))
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            XCTAssertEqual(UIColor(PersonalStyle.background).resolvedColor(with: traits), UIColor.systemGroupedBackground.resolvedColor(with: traits))
            XCTAssertEqual(UIColor(PersonalStyle.card).resolvedColor(with: traits), UIColor.secondarySystemGroupedBackground.resolvedColor(with: traits))
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            XCTAssertTrue(accent.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha))
            XCTAssertGreaterThan(green, red)
            XCTAssertGreaterThan(green, blue)
        }
        XCTAssertNotEqual(accent.resolvedColor(with: .init(userInterfaceStyle: .light)), accent.resolvedColor(with: .init(userInterfaceStyle: .dark)))
    }

    @MainActor func testOfflinePreviewRulesCompileInWebKit() async {
        let compiled = expectation(description: "Offline content rules compile")
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "artifact-preview-rules-test", encodedContentRuleList: OfflineHTMLPreview.contentRules) { list, error in
            XCTAssertNil(error)
            XCTAssertNotNil(list)
            compiled.fulfill()
        }
        await fulfillment(of: [compiled], timeout: 10)
    }
    private func task(_ status: String, finishedAt: Double? = nil) throws -> RemoteTask {
        var value: [String: Any] = ["id": "test", "backend": "qwen", "project": "project", "request": "work", "status": status,
            "createdAt": 1_000, "updatedAt": 5_000, "activity": "", "output": "", "outputTruncated": false, "permissions": [], "events": []]
        if let finishedAt { value["finishedAt"] = finishedAt }
        return try JSONDecoder().decode(RemoteTask.self, from: JSONSerialization.data(withJSONObject: value))
    }
    func testEveryTerminalStatusFreezesTheActualRunDuration() throws {
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let task = try task(status, finishedAt: 4_000)
            XCTAssertEqual(task.elapsed(at: Date(timeIntervalSince1970: 10)), 3)
            XCTAssertEqual(task.elapsed(at: Date(timeIntervalSince1970: 100)), 3)
        }
        XCTAssertEqual(try task("completed").elapsed(at: Date(timeIntervalSince1970: 100)), 4, "Older gateways use the last terminal update")
    }
    func testWorkingAndStoppingTurnsKeepCountingWithoutNegativeDurations() throws {
        for status in ["starting", "running", "waiting", "cancelling"] {
            let task = try task(status)
            XCTAssertEqual(task.elapsed(at: Date(timeIntervalSince1970: 10)), 9)
            XCTAssertEqual(task.elapsed(at: Date(timeIntervalSince1970: 20)), 19)
            XCTAssertEqual(task.elapsed(at: Date(timeIntervalSince1970: 0)), 0)
        }
    }
    func testMarkdownPreviewPreservesHeadingsListsInlineFormattingAndCode() {
        let blocks = MarkdownPreviewBlock.parse("# Report\n\n**Done**\n\n- First\n- Second\n\n```swift\nlet result = 1\n# code, not a heading\n```")
        XCTAssertEqual(blocks.map(\.text), ["Report", "**Done**", "• First", "• Second", "let result = 1\n# code, not a heading"])
        XCTAssertEqual(blocks.first?.heading, 1)
        XCTAssertEqual(blocks.last?.code, true)
    }
}
