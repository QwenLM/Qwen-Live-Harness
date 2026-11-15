import SwiftUI

enum PersonalStyle {
    static let accent = Color("AccentColor")
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
}

struct SavedInputDetail: View {
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.dismiss) private var dismiss
    let inputID: UUID
    @State private var confirmDelete = false
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Group {
                if let input = assistant.input(inputID) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            Label(tr("assistantSavedInput"), systemImage: input.source == .voice ? "mic" : "tray")
                                .font(.caption).foregroundStyle(.secondary)
                            if !input.text.isEmpty { Text(input.text).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            if !input.images.isEmpty { ImageAttachmentStrip(images: input.images, store: assistant.imageStore) }
                            if let workspace = input.workspace {
                                VStack(alignment: .leading, spacing: 6) {
                                    Label(workspace.computerName, systemImage: "laptopcomputer")
                                    Label(workspace.project.path, systemImage: "folder").textSelection(.enabled)
                                }.font(.footnote).foregroundStyle(.secondary)
                            }
                            Text(input.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            Text(tr("assistantInputPendingSummary")).font(.footnote).foregroundStyle(.secondary)
                            if !input.text.isEmpty {
                                Button {
                                    UIPasteboard.general.string = input.text; copied = true
                                } label: { Label(tr(copied ? "copiedInput" : "copyInput"), systemImage: "doc.on.doc") }
                                    .frame(minHeight: 44)
                                ShareLink(item: input.text).frame(minHeight: 44)
                            }
                            Button(tr("deleteSavedInput"), role: .destructive) { confirmDelete = true }.frame(minHeight: 44)
                        }.padding(24)
                    }
                } else { ContentUnavailableView(tr("savedInputUnavailable"), systemImage: "tray") }
            }
            .navigationTitle(tr("savedInputDetail")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { dismiss() } } }
            .confirmationDialog(tr("deleteSavedInput"), isPresented: $confirmDelete, titleVisibility: .visible) {
                Button(tr("deleteSavedInput"), role: .destructive) { assistant.deleteInput(inputID); dismiss() }
            } message: { Text(tr("deleteSavedInputDetail")) }
        }
    }
}
