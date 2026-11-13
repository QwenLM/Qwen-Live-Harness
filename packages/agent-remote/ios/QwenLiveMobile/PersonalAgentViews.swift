import SwiftUI

struct PersonalAgentView: View {
    var body: some View {
        List {
            Section {
                Text(tr("personalHeadline")).font(.title2.weight(.semibold))
                Text(tr("personalIntro")).foregroundStyle(.secondary)
            }
            Section {
                feature("personalContinuity", detail: "personalContinuityDetail", symbol: "bubble.left.and.bubble.right")
                feature("personalMemory", detail: "personalMemoryDetail", symbol: "brain")
                feature("personalProactive", detail: "personalProactiveDetail", symbol: "bell.badge")
            }
            Section {
                NavigationLink { PersonalPreviewView() } label: { Label(tr("previewPersonal"), systemImage: "play.rectangle") }
                    .accessibilityIdentifier("previewPersonal")
            } footer: { Text(tr("personalPlannedExplanation")) }
        }
        .navigationTitle(tr("personalAgent"))
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Text(tr("planned")).font(.footnote).foregroundStyle(.secondary) } }
    }

    private func feature(_ title: String, detail: String, symbol: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 6) {
                Text(tr(title))
                Text(tr(detail)).font(.footnote).foregroundStyle(.secondary)
            }.padding(.vertical, 4)
        } icon: { Image(systemName: symbol).foregroundStyle(.tint) }
    }
}

private struct PersonalPreviewView: View {
    var body: some View {
        List {
            Section {
                Label(tr("conceptPreview"), systemImage: "info.circle").font(.subheadline)
                Text(tr("personalPreviewExplanation")).font(.footnote).foregroundStyle(.secondary)
            }
            Section(tr("personalMemory")) {
                Label(tr("sampleMemory"), systemImage: "brain")
                DisclosureGroup(tr("memorySource")) { Text(tr("sampleMemorySource")).font(.footnote).foregroundStyle(.secondary) }
            }
            Section(tr("sampleEarlierConversation")) {
                Text(tr("samplePersonalRequest"))
                Label(tr("samplePersonalResponse"), systemImage: "sparkles").foregroundStyle(.secondary)
            }
            Section(tr("sampleProactiveMessage")) {
                Text(tr("sampleSuggestion"))
                DisclosureGroup(tr("suggestionReason")) { Text(tr("sampleSuggestionReason")).font(.footnote).foregroundStyle(.secondary) }
                Text(tr("personalHandoffExplanation")).font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Text(tr("personalPlannedExplanation")).font(.footnote).foregroundStyle(.secondary)
            }
        }.navigationTitle(tr("previewPersonal")).navigationBarTitleDisplayMode(.inline)
    }
}
