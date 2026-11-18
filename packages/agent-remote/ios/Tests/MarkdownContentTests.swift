import XCTest
@testable import QwenLiveMobile

final class MarkdownContentTests: XCTestCase {
    func testMarkdownRendersHeadingsInlineFormattingListsQuotesAndCode() {
        let blocks = MarkdownBlock.parse("""
        # Report

        **Done** with `result`.

        3. First
           - Nested
        4. Second

        > Quoted

        ---

        ```swift
        let result = 1
        # code, not a heading
        ```
        """)
        XCTAssertEqual(blocks.count, 8)
        guard case .text(let heading, 1, 0, nil, false) = blocks.first,
              case .text(let paragraph, 0, 0, nil, false) = blocks.dropFirst().first,
              case .text(let first, 0, 0, "3.", false) = blocks.dropFirst(2).first,
              case .text(let nested, 0, 1, "•", false) = blocks.dropFirst(3).first,
              case .text(let second, 0, 0, "4.", false) = blocks.dropFirst(4).first,
              case .text(let quote, 0, 0, nil, true) = blocks.dropFirst(5).first,
              case .rule = blocks.dropFirst(6).first,
              case .code(let code) = blocks.last else { return XCTFail("Unexpected Markdown block structure") }
        XCTAssertEqual(String(heading.characters), "Report")
        XCTAssertEqual(String(paragraph.characters), "Done with result.")
        XCTAssertTrue(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertEqual(String(first.characters), "First")
        XCTAssertEqual(String(nested.characters), "Nested")
        XCTAssertEqual(String(second.characters), "Second")
        XCTAssertEqual(String(quote.characters), "Quoted")
        XCTAssertEqual(code, "let result = 1\n# code, not a heading")
    }

    func testTableKeepsEmptyCellsInTheirColumns() {
        let blocks = MarkdownBlock.parse("| Name | Notes | Count |\n| --- | --- | ---: |\n| Build | | **2** |\n\nAfter")
        guard case .table(let table) = blocks.first,
              case .text(let after, 0, 0, nil, false) = blocks.last else { return XCTFail("Expected a table followed by text") }
        XCTAssertEqual(table.columns.count, 3)
        XCTAssertEqual(table.columns.last?.alignment, .right)
        XCTAssertEqual(table.rows.map(\.header), [true, false])
        XCTAssertNil(table.rows.last?.cells[1])
        let count = table.rows.last?.cells[2]
        XCTAssertEqual(count.map { String($0.characters) }, "2")
        XCTAssertTrue(count?.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true } == true)
        XCTAssertEqual(String(after.characters), "After")
    }

    func testStreamingCodeAndPlainTextRemainReadable() {
        guard case .text(let paragraph, 0, 0, nil, false) = MarkdownBlock.parse("one\ntwo **pending").first,
              case .code(let code) = MarkdownBlock.parse("```swift\nlet result =").first else {
            return XCTFail("Expected readable partial Markdown")
        }
        XCTAssertEqual(String(paragraph.characters), "one\ntwo **pending")
        XCTAssertEqual(code, "let result =")
        guard case .text(let source, 0, 0, nil, false) = MarkdownBlock.parse("[ref]: https://example.com").first else {
            return XCTFail("Expected a plain-text fallback when parsing yields no visible text")
        }
        XCTAssertEqual(String(source.characters), "[ref]: https://example.com")
    }

    func testExternalImagesOnlyKeepTheirAltTextAndHTMLRemainsText() {
        let source = "![Diagram](https://example.com/image.png)\n\n<script>inert()</script>"
        let blocks = MarkdownBlock.parse(source)
        guard case .text(let image, _, _, _, _) = blocks.first,
              case .text(let html, _, _, _, _) = blocks.last else { return XCTFail("Expected text only") }
        XCTAssertEqual(String(image.characters), "Diagram")
        XCTAssertTrue(image.runs.allSatisfy { $0.imageURL == nil })
        XCTAssertTrue(String(html.characters).contains("<script>inert()</script>"))
    }
}
