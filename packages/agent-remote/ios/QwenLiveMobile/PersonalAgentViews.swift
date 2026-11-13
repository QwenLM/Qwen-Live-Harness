import SwiftUI

enum PersonalStyle {
    static let background = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.08, green: 0.11, blue: 0.09, alpha: 1)
        : UIColor(red: 0.98, green: 0.985, blue: 0.97, alpha: 1) })
    static let card = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.14, green: 0.18, blue: 0.15, alpha: 1)
        : UIColor(red: 0.94, green: 0.955, blue: 0.925, alpha: 1) })
}

struct PersonalAgentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var voice = VoiceInputModel()
    let openActivity: (ActivityLink) -> Void
    @State private var latestSaved: UUID?
    @State private var selectedInput: AssistantInput?
    @State private var liveUnavailable = false
    @State private var inputSource = AssistantInput.Source.text
    @State private var voiceTask: Task<Void, Never>?
    @FocusState private var editing: Bool

    private var recent: [PersonalActivity] {
        PersonalActivity.recent(state: model.state, computerID: model.selectedComputerID,
                                contextID: model.contextID, inputs: assistant.inputs)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(tr("recentThreeThings")).font(.subheadline).foregroundStyle(.secondary).padding(.bottom, 4)
                    if recent.isEmpty {
                        ContentUnavailableView(tr("assistantEmpty"), systemImage: "sparkles", description: Text(tr("assistantEmptyDetail")))
                            .frame(maxWidth: .infinity).padding(.vertical, 30)
                    }
                    ForEach(recent) { item in
                        RecentActivityCard(item: item, stale: item.link != nil && model.connectionError != nil) {
                            if case .input(let input) = item.content { selectedInput = input }
                            else if let link = item.link { openActivity(link) }
                        }
                    }
                    if let latestSaved, assistant.input(latestSaved) != nil {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(tr("assistantCaptureReceipt")).font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Button { self.latestSaved = nil } label: {
                                    Image(systemName: "xmark").font(.caption).frame(width: 44, height: 44)
                                }.accessibilityLabel(tr("dismissReceipt"))
                            }
                            Text(tr("assistantCapturedLocally")).font(.subheadline).foregroundStyle(.secondary)
                                .accessibilityIdentifier("assistantReceipt")
                            Button(tr("viewSavedInput")) { selectedInput = assistant.input(latestSaved) }
                                .font(.subheadline).frame(minHeight: 44)
                        }.padding(.top, 12).id("receipt")
                    }
                    if let error = assistant.error { ErrorNote(text: error) }
                    if let error = voice.error {
                        VStack(alignment: .leading) {
                            ErrorNote(text: error)
                            Button(tr("dismiss")) { voice.clearError() }.font(.footnote).frame(minHeight: 44)
                        }
                    }
                }.padding(.horizontal, 22).padding(.vertical, 18)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: latestSaved) { _, value in
                if value != nil { withAnimation { proxy.scrollTo("receipt", anchor: .bottom) } }
            }
        }
        .background(PersonalStyle.background)
        .navigationTitle(tr("personalAgent"))
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(item: $selectedInput) { input in SavedInputDetail(inputID: input.id) }
        .alert(tr("liveNotConnected"), isPresented: $liveUnavailable) {
            Button(tr("done"), role: .cancel) {}
        } message: { Text(tr("liveNotConnectedDetail")) }
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopVoice() } }
        .onDisappear { stopVoice() }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if voice.phase != .idle {
                Label(tr(voice.phase == .authorizing ? "dictationAuthorizing" : "dictationListening"), systemImage: "waveform")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 4) {
                Button {
                    if assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { editing = true }
                    else if let saved = assistant.saveInput(source: inputSource) {
                        latestSaved = saved.id; inputSource = .text; editing = false
                    }
                } label: {
                    Image(systemName: assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "keyboard" : "arrow.up")
                        .font(.system(size: 20, weight: .medium)).frame(width: 44, height: 44)
                }.disabled(voice.phase != .idle)
                    .accessibilityLabel(tr(assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "textInput" : "saveAssistantInput"))
                    .accessibilityIdentifier("assistantSend")
                TextField(tr("assistantInputPlaceholder"), text: Binding(get: { assistant.draft }, set: {
                    assistant.draft = $0; inputSource = .text
                }), axis: .vertical)
                    .font(.body).lineLimit(1...5).textFieldStyle(.plain).focused($editing)
                    .frame(minHeight: 44).disabled(voice.phase != .idle)
                    .accessibilityIdentifier("assistantInput")
                Button {
                    if voice.phase == .idle {
                        editing = false
                        let prefix = assistant.draft.isEmpty ? "" : assistant.draft + "\n"
                        voiceTask = Task {
                            await voice.start(localeIdentifier: assistant.dictationLanguage.localeIdentifier) { text in
                                guard !text.isEmpty else { return }
                                inputSource = .voice; assistant.draft = prefix + text
                            }
                        }
                    } else { stopVoice() }
                } label: {
                    Image(systemName: voice.phase == .idle ? "mic" : "stop.fill")
                        .font(.system(size: 20)).frame(width: 44, height: 44)
                }.accessibilityLabel(tr(voice.phase == .idle ? "voiceInput" : "stopVoiceInput"))
                    .accessibilityIdentifier("assistantVoice")
                Rectangle().fill(Color(uiColor: .separator)).frame(width: 0.5, height: 26).padding(.bottom, 9)
                Button { editing = false; liveUnavailable = true } label: {
                    Label("Live", systemImage: "waveform").font(.subheadline).fixedSize().frame(minHeight: 44).padding(.horizontal, 4)
                }.disabled(voice.phase != .idle).accessibilityIdentifier("assistantLive")
                    .accessibilityHint(tr("liveNotConnected"))
            }
            .padding(8).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Color(uiColor: .separator).opacity(0.2), lineWidth: 0.5))
        }.padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 10).background(PersonalStyle.background)
    }

    private func stopVoice() { voiceTask?.cancel(); voiceTask = nil; voice.stop() }
}

private struct RecentActivityCard: View {
    let item: PersonalActivity
    let stale: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    Label(stale ? tr("lastKnownState") : item.category, systemImage: item.symbol)
                    Spacer()
                    Text(item.date, style: .relative).lineLimit(1)
                }.font(.caption2).foregroundStyle(.secondary)
                Text(item.title).font(.body.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                Text(item.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                .background(PersonalStyle.card, in: RoundedRectangle(cornerRadius: 18))
        }.buttonStyle(.plain).accessibilityElement(children: .combine).accessibilityIdentifier("recent-" + item.id)
    }
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
                            Text(input.text).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            Text(input.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            Text(tr("assistantInputPendingSummary")).font(.footnote).foregroundStyle(.secondary)
                            Button {
                                UIPasteboard.general.string = input.text; copied = true
                            } label: { Label(tr(copied ? "copiedInput" : "copyInput"), systemImage: "doc.on.doc") }
                                .frame(minHeight: 44)
                            ShareLink(item: input.text).frame(minHeight: 44)
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
