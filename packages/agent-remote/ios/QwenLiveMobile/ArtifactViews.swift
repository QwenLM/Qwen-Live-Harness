import SwiftUI
import WebKit
import ImageIO

struct ArtifactList: View {
    let task: RemoteTask
    let contextID: UUID
    let runID: String
    @State private var selected: RemoteArtifact?

    var body: some View {
        if task.artifactsPending == true || task.artifactNotice != nil || !(task.artifacts ?? []).isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Label(tr("artifacts"), systemImage: "doc.richtext").font(.subheadline.weight(.semibold))
                if task.artifactsPending == true { ProgressView(tr("preparingArtifacts")).font(.footnote) }
                ForEach(task.artifacts ?? []) { artifact in
                    Button { selected = artifact } label: {
                        HStack(spacing: 12) {
                            Image(systemName: artifact.kind == "image" ? "photo" : artifact.kind == "html" ? "globe" : "doc.text")
                                .font(.title2).frame(width: 32)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(artifact.name).font(.subheadline.weight(.medium)).lineLimit(2).foregroundStyle(.primary)
                                Text(tr("preview") + " · " + ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                        }.padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    }.buttonStyle(.plain).accessibilityIdentifier("artifact-\(artifact.name)")
                }
                if let notice = task.artifactNotice { Text(tr(notice)).font(.footnote).foregroundStyle(.secondary) }
            }
            .sheet(item: $selected) { artifact in
                ArtifactPreview(artifact: artifact, taskID: task.id, contextID: contextID, runID: runID)
            }
        }
    }
}

struct ArtifactPreview: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let artifact: RemoteArtifact
    let taskID: String
    let contextID: UUID
    let runID: String
    @State private var data: Data?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    ContentUnavailableView(tr("previewUnavailable"), systemImage: "doc.badge.ellipsis", description: Text(error))
                } else if let data { preview(data) }
                else { ProgressView(tr("loadingPreview")) }
            }
            .navigationTitle(artifact.name).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { dismiss() }.accessibilityIdentifier("closePreview") } }
        }
        .task {
            do { data = try await model.loadArtifact(artifact, taskID: taskID, expectedContext: contextID, runID: runID) }
            catch is CancellationError { dismiss() }
            catch { self.error = error.localizedDescription }
        }
        .onChange(of: model.contextID) { _, value in if value != contextID { dismiss() } }
        .onChange(of: model.state?.runId) { _, value in if value != runID { dismiss() } }
    }

    @ViewBuilder private func preview(_ data: Data) -> some View {
        if artifact.kind == "image", artifact.mimeType != "image/svg+xml" {
            if let image = previewImage(data) { ZoomableArtifactImage(image: image).accessibilityIdentifier("imagePreview") }
            else { ContentUnavailableView(tr("previewUnavailable"), systemImage: "photo.badge.exclamationmark") }
        } else if artifact.mimeType == "image/svg+xml" {
            OfflineHTMLPreview(html: "<img alt='" + tr("artifacts") + "' src='data:image/svg+xml;base64," + data.base64EncodedString() + "'>", onError: { error = $0 })
                .accessibilityIdentifier("imagePreview")
        } else if let text = String(data: data, encoding: .utf8) {
            VStack(spacing: 0) {
                if artifact.kind == "html" {
                    Text(tr("staticHTMLPreview")).font(.caption).foregroundStyle(.secondary).padding(10)
                    OfflineHTMLPreview(html: String(text.prefix(512_000)), onError: { error = $0 }).accessibilityIdentifier("htmlPreview")
                } else { MarkdownArtifactPreview(text: String(text.prefix(512_000))).accessibilityIdentifier("markdownPreview") }
                if text.count > 512_000 { Text(tr("previewTruncated")).font(.caption).foregroundStyle(.secondary).padding(8) }
            }
        } else { ContentUnavailableView(tr("previewUnavailable"), systemImage: "doc.badge.ellipsis") }
    }

    private func previewImage(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = info[kCGImagePropertyPixelWidth] as? Double,
              let height = info[kCGImagePropertyPixelHeight] as? Double,
              width > 0, height > 0, width * height <= 64_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

private struct ZoomableArtifactImage: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView(); scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 5
        let view = context.coordinator.imageView; view.image = image; view.contentMode = .scaleAspectFit
        scroll.addSubview(view); return scroll
    }
    func updateUIView(_ view: UIScrollView, context: Context) {
        context.coordinator.imageView.image = image
        context.coordinator.imageView.frame = view.bounds
        context.coordinator.imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    }
}

struct MarkdownArtifactPreview: View {
    let text: String
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(Array(MarkdownPreviewBlock.parse(text).enumerated()), id: \.offset) { _, block in
                    if block.code {
                        ScrollView(.horizontal) { Text(block.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(12) }
                            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    } else {
                        Text((try? AttributedString(markdown: block.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.text))
                            .font(block.heading == 1 ? .title : block.heading == 2 ? .title2 : block.heading > 0 ? .headline : .body)
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }
                }
            }.padding()
        }.environment(\.openURL, OpenURLAction { _ in .discarded })
    }
}

struct MarkdownPreviewBlock {
    var text: String
    var heading = 0
    var code = false
    static func parse(_ text: String) -> [Self] {
        var blocks: [Self] = [], lines: [String] = [], code = false
        func flush() { if !lines.isEmpty { blocks.append(Self(text: lines.joined(separator: "\n"), code: code)); lines = [] } }
        for line in text.components(separatedBy: .newlines) {
            if line.hasPrefix("```") || line.hasPrefix("~~~") { flush(); code.toggle() }
            else if code { lines.append(line) }
            else if line.trimmingCharacters(in: .whitespaces).isEmpty { flush() }
            else {
                let level = line.prefix(while: { $0 == "#" }).count
                if (1...6).contains(level), line.dropFirst(level).first == " " {
                    flush(); blocks.append(Self(text: String(line.dropFirst(level + 1)), heading: level))
                } else if line.hasPrefix("- ") || line.hasPrefix("* ") { flush(); blocks.append(Self(text: "• " + line.dropFirst(2))) }
                else { lines.append(line) }
            }
        }
        flush(); return blocks
    }
}

struct OfflineHTMLPreview: UIViewRepresentable {
    let html: String
    let onError: (String) -> Void
    static let contentRules = #"[{"trigger":{"url-filter":"^http:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ws:"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss:"},"action":{"type":"block"}}]"#
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "agent-remote-offline-preview-v1", encodedContentRuleList: Self.contentRules) { list, error in
            DispatchQueue.main.async {
                guard let list else { onError(error?.localizedDescription ?? tr("previewUnavailable")); return }
                view.configuration.userContentController.add(list)
                view.loadHTMLString(Self.document(html), baseURL: nil)
            }
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func document(_ html: String) -> String {
        "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\"><style>:root{color-scheme:light dark}body{font:17px -apple-system;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>" + html + "</body></html>"
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }
    }
}
