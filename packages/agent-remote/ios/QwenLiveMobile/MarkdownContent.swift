import SwiftUI

struct MarkdownContent: View {
    let text: String
    @ScaledMetric(relativeTo: .subheadline) private var cellWidth = 220.0

    var body: some View {
        ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
            switch block {
            case .text(let content, let heading, let listDepth, let marker, let quoted):
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let marker { Text(verbatim: marker).foregroundStyle(.secondary) }
                    Text(content)
                        .font(heading == 1 ? .title2.weight(.semibold) : heading == 2 ? .title3.weight(.semibold) : heading > 0 ? .headline : .body)
                        .accessibilityAddTraits(heading > 0 ? .isHeader : [])
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, CGFloat(min(listDepth, 4)) * 14 + (marker == nil && listDepth > 0 ? 18 : 0))
                .padding(.leading, quoted ? 12 : 0)
                .overlay(alignment: .leading) {
                    if quoted { Capsule().fill(.secondary.opacity(0.35)).frame(width: 3).accessibilityHidden(true) }
                }
                .textSelection(.enabled)
            case .code(let code):
                ScrollView(.horizontal) {
                    Text(verbatim: code).font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled).padding(12)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
            case .rule:
                Divider()
            case .table(let table):
                tableView(table)
            }
        }
        .environment(\.openURL, OpenURLAction { _ in .discarded })
    }

    private func tableView(_ table: MarkdownTable) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 0) {
                ForEach(table.rows) { row in
                    GridRow(alignment: .top) {
                        ForEach(table.columns.indices, id: \.self) { column in
                            Text(row.cells[column] ?? AttributedString())
                                .font(row.header ? .subheadline.weight(.semibold) : .subheadline)
                                .accessibilityAddTraits(row.header ? .isHeader : [])
                                .textSelection(.enabled)
                                .frame(maxWidth: cellWidth, alignment: .leading)
                                .padding(.vertical, 8)
                                .gridColumnAlignment(table.columns[column].alignment == .right ? .trailing :
                                    table.columns[column].alignment == .center ? .center : .leading)
                        }
                    }
                    Divider().gridCellUnsizedAxes(.horizontal)
                }
            }
            .padding(.horizontal, 12)
        }
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct MarkdownTable {
    struct Row: Identifiable {
        let id: Int
        let header: Bool
        var cells: [Int: AttributedString] = [:]
    }

    let id: Int
    let columns: [PresentationIntent.TableColumn]
    var rows: [Row] = []
}

enum MarkdownBlock {
    case text(AttributedString, heading: Int, listDepth: Int, marker: String?, quoted: Bool)
    case code(String)
    case rule
    case table(MarkdownTable)

    static func parse(_ source: String) -> [Self] {
        guard !source.isEmpty else { return [] }
        let fallback = Self.text(AttributedString(source), heading: 0, listDepth: 0, marker: nil, quoted: false)
        guard let parsed = try? AttributedString(markdown: source), !parsed.characters.isEmpty else { return [fallback] }
        var blocks: [Self] = []
        var table: MarkdownTable?
        var markedItems = Set<Int>()

        for (intent, range) in parsed.runs[\.presentationIntent] {
            let components = intent?.components ?? []
            let content = parsed[range]
            if components.count >= 3, case .tableCell(let column) = components[0].kind,
               case .table(let columns) = components[2].kind {
                let tableID = components[2].identity
                let row = components[1]
                if table?.id != tableID {
                    if let table { blocks.append(.table(table)) }
                    table = MarkdownTable(id: tableID, columns: columns)
                }
                if table?.rows.last?.id != row.identity {
                    table?.rows.append(MarkdownTable.Row(id: row.identity, header: row.kind == .tableHeaderRow))
                }
                if let lastIndex = table?.rows.indices.last {
                    table?.rows[lastIndex].cells[column] = inlineText(content)
                }
                continue
            }
            if let current = table {
                blocks.append(.table(current))
                table = nil
            }

            switch components.first?.kind {
            case .codeBlock:
                let code = content.characters
                blocks.append(.code(String(code.last == "\n" ? code.dropLast() : code[...])))
            case .thematicBreak:
                blocks.append(.rule)
            default:
                var heading = 0
                if case .header(let level) = components.first?.kind { heading = level }
                let items = components.indices.filter {
                    if case .listItem = components[$0].kind { return true }
                    return false
                }
                var marker: String?
                if let item = items.first, case .listItem(let ordinal) = components[item].kind,
                   markedItems.insert(components[item].identity).inserted {
                    marker = components.dropFirst(item + 1).first?.kind == .orderedList ? "\(ordinal)." : "•"
                }
                blocks.append(.text(inlineText(content), heading: heading, listDepth: max(0, items.count - (marker == nil ? 0 : 1)),
                                    marker: marker, quoted: components.contains { $0.kind == .blockQuote }))
            }
        }
        if let table { blocks.append(.table(table)) }
        return blocks
    }

    private static func inlineText(_ content: AttributedSubstring) -> AttributedString {
        var result = AttributedString()
        for run in content.runs {
            if run.inlinePresentationIntent?.contains(.softBreak) == true {
                result.append(AttributedString("\n"))
            } else {
                var span = AttributedString(content[run.range])
                span.imageURL = nil
                result.append(span)
            }
        }
        return result
    }
}
