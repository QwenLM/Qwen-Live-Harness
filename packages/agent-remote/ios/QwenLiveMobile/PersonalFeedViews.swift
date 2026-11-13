import SwiftUI

struct PersonalFeedView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.dynamicTypeSize) private var typeSize
    let openActivity: (ActivityLink) -> Void
    var favoritesOnly = false
    @State private var selected: PersonalActivity?
    @State private var pendingLink: ActivityLink?

    private var items: [PersonalActivity] {
        let all = PersonalActivity.feed(state: model.state, computerID: model.selectedComputerID,
                                        contextID: model.contextID, inputs: assistant.inputs)
        return favoritesOnly ? all.filter { assistant.favorites.contains($0.id) } : all
    }

    var body: some View {
        ScrollView {
            if items.isEmpty {
                ContentUnavailableView(tr(favoritesOnly ? "favoritesEmpty" : "feedEmpty"), systemImage: "square.grid.2x2",
                    description: Text(tr(favoritesOnly ? "favoritesEmptyDetail" : "feedEmptyDetail")))
                    .padding(.top, 70)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: typeSize.isAccessibilitySize ? 1 : 2),
                          alignment: .leading, spacing: 20) {
                    ForEach(items) { item in
                        Button { selected = item } label: { FeedActivityCard(item: item) }
                            .buttonStyle(.plain).accessibilityIdentifier("feed-" + item.id)
                    }
                }.padding(16)
            }
            if model.connectionError != nil, model.state != nil {
                Text(tr("feedLastSynced")).font(.caption).foregroundStyle(.secondary).padding()
            }
        }
        .background(PersonalStyle.background)
        .navigationTitle(tr(favoritesOnly ? "favorites" : "feed")).navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .sheet(item: $selected, onDismiss: {
            if let link = pendingLink { pendingLink = nil; openActivity(link) }
        }) { item in
            switch item.content {
            case .input(let input): SavedInputDetail(inputID: input.id)
            case .artifact(let artifact, let task):
                if let link = item.link {
                    ArtifactPreview(artifact: artifact, taskID: task.id, contextID: link.contextID, runID: link.runID)
                }
            case .task:
                FeedResultDetail(item: item) { link in pendingLink = link; selected = nil }
            }
        }
        .onChange(of: model.contextID) { _, _ in selected = nil; pendingLink = nil }
        .onChange(of: model.state?.runId) { _, _ in selected = nil; pendingLink = nil }
    }
}

private struct FeedActivityCard: View {
    let item: PersonalActivity
    private var isImage: Bool {
        if case .artifact(let artifact, _) = item.content { return artifact.kind == "image" }
        return false
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            VStack(alignment: .leading, spacing: 14) {
                Text(item.category).font(.caption2).foregroundStyle(.secondary)
                Text(coverText).font(.headline.weight(.medium)).foregroundStyle(.primary).lineLimit(4)
                Spacer(minLength: 10)
                Image(systemName: item.symbol).font(.system(size: isImage ? 38 : 27, weight: .light))
                    .foregroundStyle(.tint).frame(maxWidth: .infinity, alignment: .trailing)
            }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: isImage ? 184 : 152, alignment: .topLeading)
                .padding(15).background(PersonalStyle.card, in: RoundedRectangle(cornerRadius: 15))
            Text(item.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2).padding(.horizontal, 3)
            Text(item.date, style: .relative).font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 3)
        }.accessibilityElement(children: .combine)
    }
    private var coverText: String {
        if case .artifact = item.content { return item.title }
        return item.summary
    }
}

private struct FeedResultDetail: View {
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.dismiss) private var dismiss
    let item: PersonalActivity
    let openActivity: (ActivityLink) -> Void
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Label(item.category, systemImage: item.symbol).font(.caption).foregroundStyle(.secondary)
                    Text(item.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                    if case .task(let task) = item.content {
                        Text(task.output.isEmpty ? item.summary : task.output).font(.body).textSelection(.enabled)
                        if task.outputTruncated { Text(tr("feedOutputTruncated")).font(.footnote).foregroundStyle(.secondary) }
                    }
                    Text(item.date, style: .date).font(.caption).foregroundStyle(.secondary)
                    if let link = item.link {
                        Button { openActivity(link); dismiss() } label: {
                            Label(tr("viewInWorkbench"), systemImage: "arrow.right").frame(minHeight: 44)
                        }.accessibilityIdentifier("feedOpenWorkbench")
                    }
                }.padding(22)
            }
            .navigationTitle(tr("feedResult")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { assistant.toggleFavorite(item.id) } label: {
                        Image(systemName: assistant.favorites.contains(item.id) ? "bookmark.fill" : "bookmark")
                    }.accessibilityLabel(tr("favorites")).accessibilityIdentifier("favoriteFeedItem")
                }
                ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { dismiss() } }
            }
        }
    }
}
