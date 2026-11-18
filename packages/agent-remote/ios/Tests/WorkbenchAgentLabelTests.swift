import UIKit
import XCTest
@testable import QwenLiveMobile

final class WorkbenchAgentLabelTests: XCTestCase {
    @MainActor func testKnownBackendsHaveBundledLogosAndUnknownBackendsUseTheFallback() throws {
        let qwen = try XCTUnwrap(WorkbenchAgentLabel.logoAsset(for: "qwen"))
        let codex = try XCTUnwrap(WorkbenchAgentLabel.logoAsset(for: "codex"))
        XCTAssertEqual(qwen, "QwenCodeLogo")
        XCTAssertEqual(codex, "OpenAILogo")
        XCTAssertEqual(try XCTUnwrap(UIImage(named: qwen)).renderingMode, .alwaysTemplate)
        let light = try XCTUnwrap(UIImage(named: codex, in: .main, compatibleWith: .init(userInterfaceStyle: .light)))
        let dark = try XCTUnwrap(UIImage(named: codex, in: .main, compatibleWith: .init(userInterfaceStyle: .dark)))
        XCTAssertNotEqual(try XCTUnwrap(light.pngData()), try XCTUnwrap(dark.pngData()))
        XCTAssertNil(WorkbenchAgentLabel.logoAsset(for: "unknown"))
        XCTAssertNil(WorkbenchAgentLabel.logoAsset(for: "Codex"))
    }
}
