import SwiftUI

struct PersonalFeedView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var assistant: AssistantModel
    let openActivity: (ActivityLink) -> Void
    var favoritesOnly = false
    var openDraft: (InsightCard) -> Void = { _ in }
    @State private var error: String?

    private var cards: [InsightCard] {
        guard let computer = model.selectedComputerID else { return [] }
        return (model.state?.feed?.cards ?? []).filter { !favoritesOnly || assistant.favorites.contains($0.favoriteID(computerID: computer)) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                if let feed = model.state?.feed {
                    if let error = feed.error { ErrorNote(text: tr(error)) }
                    if feed.working {
                        HStack(spacing: 12) { ProgressView(); Text(tr("insightStatus_" + feed.status)).font(.subheadline) }
                            .accessibilityIdentifier("insightGenerating")
                    }
                    if cards.isEmpty { empty(feed: feed) }
                    ForEach(Array(cards.enumerated()), id: \.element.id) { index, card in
                        NavigationLink {
                            InsightDetailView(cardID: card.id, openActivity: openActivity, openDraft: openDraft)
                        } label: {
                            InsightEditorialCard(card: card, featured: index == 0)
                        }.buttonStyle(.plain).accessibilityIdentifier("insight-" + card.id)
                    }
                    if !cards.isEmpty {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "smallcircle.filled.circle").font(.caption)
                            Text(tr("insightFooter")).font(.footnote)
                        }.foregroundStyle(.secondary).padding(.horizontal, 4)
                    }
                } else {
                    ContentUnavailableView(tr("insightConnectTitle"), systemImage: "laptopcomputer",
                        description: Text(tr(model.state == nil ? "insightConnectDetail" : "insightUpdateGateway")))
                }
                if model.connectionError != nil { Text(tr("feedLastSynced")).font(.footnote).foregroundStyle(.secondary) }
                if let error { ErrorNote(text: error) }
            }.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 40).frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
        }
        .background(PersonalStyle.background)
        .navigationTitle(tr(favoritesOnly ? "favorites" : "feed")).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { InsightSourcesView() } label: { Image(systemName: "slider.horizontal.3") }
                    .accessibilityLabel(tr("insightSources")).accessibilityIdentifier("insightSources")
            }
        }
        .refreshable {
            guard let state = model.state else { return }
            let context = model.contextID
            do { try await model.changeFeed("refresh", expectedContext: context, runID: state.runId) }
            catch { if model.contextID == context { self.error = error.localizedDescription } }
        }
        .id(model.contextID)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(Date.now, format: .dateTime.month(.abbreviated).day()).textCase(.uppercase)
                Spacer()
                Text(tr("insightEdition")).tracking(2)
            }.font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Rectangle().fill(PersonalStyle.accent.opacity(0.3)).frame(height: 1)
            Text(tr(favoritesOnly ? "insightSavedTitle" : "insightHeading"))
                .font(.system(.largeTitle, design: .serif).weight(.medium)).tracking(-0.7)
                .fixedSize(horizontal: false, vertical: true)
            Text(tr("insightSubheading")).font(.subheadline).foregroundStyle(.secondary).lineSpacing(4)
        }.padding(.bottom, 2)
    }

    @ViewBuilder private func empty(feed: PersonalFeedState) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(tr(favoritesOnly ? "insightSavedEmpty" : feed.preferences.enabled ? "insightWaitingTitle" : "insightStartTitle"))
                .font(.system(.title2, design: .serif)).foregroundStyle(.primary)
            Text(tr(favoritesOnly ? "insightSavedDetail" : feed.preferences.enabled ? "insightWaitingDetail" : "insightStartDetail"))
                .font(.body).foregroundStyle(.secondary).lineSpacing(5)
            if !favoritesOnly {
                NavigationLink { InsightSourcesView() } label: {
                    HStack { Text(tr("insightChooseSources")); Image(systemName: "arrow.right") }.font(.subheadline.weight(.semibold))
                }.accessibilityIdentifier("insightSetup")
                if feed.preferences.enabled {
                    if feed.sources.filter(\.enabled).allSatisfy({ $0.count == 0 }) && !feed.working {
                        Text(tr("insightNoContext")).font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(feed.sources.filter(\.enabled)) { source in
                        HStack {
                            Text(tr("insightSource_" + source.id)); Spacer()
                            Text("\(source.count) " + tr("insightConversations") + " · " + tr("insightSourceStatus_" + source.status))
                        }
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let checked = feed.lastEvaluatedAt {
                        Text(tr("insightLastChecked") + " " + Date(timeIntervalSince1970: checked / 1000).formatted(date: .omitted, time: .shortened))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let next = feed.nextEvaluationAt, next > Date.now.timeIntervalSince1970 * 1000 {
                        Text(tr("insightNextCheck") + " " + Date(timeIntervalSince1970: next / 1000).formatted(date: .omitted, time: .shortened))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button(tr("insightCheckNow")) {
                        guard let state = model.state else { return }
                        let context = model.contextID
                        Task {
                            do { try await model.changeFeed("refresh", expectedContext: context, runID: state.runId) }
                            catch { if model.contextID == context { self.error = error.localizedDescription } }
                        }
                    }.buttonStyle(.bordered).disabled(feed.working).accessibilityIdentifier("insightCheckNow")
                }
            }
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
            .background(PersonalStyle.card, in: RoundedRectangle(cornerRadius: 22))
    }
}

private struct InsightEditorialCard: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    let card: InsightCard
    let featured: Bool
    private var ink: Color { featured ? Color(red: 0.96, green: 0.95, blue: 0.89) : .primary }
    private var muted: Color { ink.opacity(featured ? 0.78 : 0.65) }
    private var background: Color {
        if featured { return Color(red: 0.10, green: 0.24, blue: 0.20) }
        if scheme == .dark { return PersonalStyle.card }
        return card.kind == "question" ? Color(red: 0.95, green: 0.91, blue: 0.85) : Color(red: 0.89, green: 0.93, blue: 0.89)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .firstTextBaseline) {
                Text(tr("insightKind_" + card.kind)).tracking(1.5)
                Spacer(minLength: 12)
                Text(card.topic).multilineTextAlignment(.trailing)
            }.font(.caption.weight(.medium)).foregroundStyle(muted)
            Text(card.title).font(.system(featured ? .title : .title2, design: .serif).weight(.semibold))
                .tracking(-0.4).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            Text(card.summary).font(.subheadline).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(muted)
            Rectangle().fill(ink.opacity(0.2)).frame(height: 1)
            if card.kind == "connection" && !typeSize.isAccessibilitySize {
                HStack(alignment: .top, spacing: 18) {
                    ForEach(Array(card.sections.prefix(2).enumerated()), id: \.offset) { index, section in
                        VStack(alignment: .leading, spacing: 9) {
                            Text(index == 0 ? "01" : "02").font(.system(.title, design: .serif)).foregroundStyle(muted)
                            Text(section.label).font(.subheadline.weight(.semibold))
                            Text(section.text).font(.caption).lineSpacing(3).lineLimit(4).foregroundStyle(muted)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } else {
                ForEach(Array(card.sections.prefix(2).enumerated()), id: \.offset) { index, section in
                    HStack(alignment: .top, spacing: 14) {
                        Text(String(format: "%02d", index + 1)).font(.system(.title3, design: .serif)).foregroundStyle(muted)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(section.label).font(.subheadline.weight(.semibold))
                            Text(section.text).font(.caption).lineSpacing(3).lineLimit(3).foregroundStyle(muted)
                        }
                    }
                }
            }
            HStack(alignment: .firstTextBaseline) {
                Text(String(Set(card.evidence.map(\.contextId)).count) + " " + tr("insightSourceCount"))
                Spacer()
                Text(tr("insightRead")); Image(systemName: "arrow.up.right")
            }.font(.caption.weight(.medium)).foregroundStyle(muted).padding(.top, 4)
        }.foregroundStyle(ink).padding(featured ? 26 : 24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: 24))
            .accessibilityElement(children: .combine)
    }
}

private struct InsightDetailView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var assistant: AssistantModel
    @Environment(\.dismiss) private var dismiss
    let cardID: String
    let openActivity: (ActivityLink) -> Void
    let openDraft: (InsightCard) -> Void
    @State private var error: String?
    private var card: InsightCard? { model.state?.feed?.cards.first { $0.id == cardID } }

    var body: some View {
        ScrollView {
            if let card, let computer = model.selectedComputerID {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(tr("insightKind_" + card.kind) + " · " + card.topic).font(.caption.weight(.medium)).foregroundStyle(.tint)
                        Text(card.title).font(.system(.largeTitle, design: .serif).weight(.medium)).fixedSize(horizontal: false, vertical: true)
                        Text(card.summary).font(.title3).lineSpacing(5)
                        Text(card.date, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        Text(tr("insightWhy")).font(.caption.weight(.semibold)).foregroundStyle(.tint)
                        Text(card.why).font(.subheadline).lineSpacing(5)
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                        .background(PersonalStyle.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    ForEach(Array(card.sections.enumerated()), id: \.offset) { _, section in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(section.label).font(.system(.title2, design: .serif).weight(.semibold))
                            Text(section.text).font(.body).lineSpacing(6).textSelection(.enabled)
                        }
                    }
                    Divider()
                    VStack(alignment: .leading, spacing: 18) {
                        Text(tr("insightEvidence")).font(.headline)
                        ForEach(Array(card.evidence.enumerated()), id: \.offset) { _, evidence in
                            VStack(alignment: .leading, spacing: 10) {
                                HStack { Text(tr("insightSource_" + evidence.source)); Text("·"); Text(tr("insightRole_" + evidence.role)) }
                                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                                Text(evidence.title).font(.subheadline.weight(.medium))
                                Text("“" + evidence.quote + "”").font(.body).lineSpacing(5).textSelection(.enabled)
                                if evidence.incomplete { Text(tr("insightPartialContext")).font(.caption).foregroundStyle(.secondary) }
                                if let link = evidence.activityLink(computerID: computer, contextID: model.contextID, state: model.state) {
                                    Button(tr("insightOpenConversation")) { openActivity(link) }.font(.subheadline)
                                }
                            }.padding(.vertical, 6)
                        }
                    }.accessibilityIdentifier("insightEvidence")
                    VStack(alignment: .leading, spacing: 14) {
                        Text(tr("insightContinue")).font(.system(.title2, design: .serif))
                        Text(card.followUp).font(.body).lineSpacing(5)
                        Button { openDraft(card) } label: {
                            HStack { Text(tr("insightPrepareDraft")); Spacer(); Image(systemName: "arrow.right") }.padding(.vertical, 8)
                        }.buttonStyle(.borderedProminent).accessibilityIdentifier("insightContinue")
                        Text(tr("insightDraftHint")).font(.caption).foregroundStyle(.secondary)
                    }
                    Button(tr("insightDismiss")) {
                        let context = model.contextID
                        guard let state = model.state else { return }
                        Task {
                            do { try await model.changeFeed("dismiss", body: ["id": card.id], expectedContext: context, runID: state.runId); dismiss() }
                            catch { if model.contextID == context { self.error = error.localizedDescription } }
                        }
                    }.font(.subheadline).foregroundStyle(.secondary)
                    if let error { ErrorNote(text: error) }
                }.padding(24).frame(maxWidth: 680).frame(maxWidth: .infinity)
            } else { ContentUnavailableView(tr("feed_card_unavailable"), systemImage: "doc.text") }
        }.background(PersonalStyle.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let card, let computer = model.selectedComputerID {
                    ToolbarItem(placement: .topBarTrailing) {
                        let favorite = card.favoriteID(computerID: computer)
                        Button { assistant.toggleFavorite(favorite) } label: {
                            Image(systemName: assistant.favorites.contains(favorite) ? "bookmark.fill" : "bookmark")
                        }.accessibilityLabel(tr("favorites")).accessibilityIdentifier("insightFavorite")
                    }
                }
            }
    }
}

struct InsightSourcesView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var preferences = FeedPreferences(enabled: false, sources: ["workbench"], backend: "", language: "zh-CN")
    @State private var baseline: FeedPreferences?
    @State private var loaded = false
    @State private var saving = false
    @State private var error: String?
    @State private var saved = false
    @State private var confirmClear = false
    @State private var confirmLeave = false

    private var hasChanges: Bool { baseline.map { !preferences.matches($0) } ?? false }
    private var canSave: Bool { !saving && loaded && (!preferences.enabled || (!preferences.sources.isEmpty && !preferences.backend.isEmpty)) }

    var body: some View {
        Form {
            if let feed = model.state?.feed, let state = model.state {
                if hasChanges { Section { Label(tr("insightUnsaved"), systemImage: "pencil.circle").font(.subheadline) } }
                if let error { Section { ErrorNote(text: error) } }
                Section {
                    Toggle(tr("insightEnable"), isOn: $preferences.enabled).accessibilityIdentifier("insightEnable")
                    Text(tr("insightSourceExplanation")).font(.subheadline).foregroundStyle(.secondary)
                }
                Section {
                    ForEach(["workbench", "codex", "qwen"], id: \.self) { source in
                        Toggle(isOn: Binding(get: { preferences.sources.contains(source) }, set: { value in
                            preferences.sources.removeAll { $0 == source }; if value { preferences.sources.append(source) }
                        })) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(tr("insightSource_" + source))
                                Text(tr("insightSourceDetail_" + source)).font(.caption).foregroundStyle(.secondary)
                                if let reading = feed.sources.first(where: { $0.id == source }), reading.enabled {
                                    Text("\(reading.count) " + tr("insightConversations") + " · " + tr("insightSourceStatus_" + reading.status))
                                        .font(.caption).foregroundStyle(reading.status == "error" ? .red : .secondary)
                                }
                            }
                        }.accessibilityIdentifier("insightSource-" + source)
                    }
                } header: { Text(tr("insightSources")) } footer: { Text(tr("insightSourceScope")) }
                Section {
                    Picker(tr("agent"), selection: $preferences.backend) {
                        ForEach(state.backends) { Text($0.name).tag($0.id) }
                    }
                    Picker(tr("insightLanguage"), selection: $preferences.language) {
                        Text("简体中文").tag("zh-CN"); Text("English").tag("en")
                    }.accessibilityIdentifier("insightLanguage")
                    Button { save() } label: {
                        HStack {
                            Text(tr(saved ? "insightSourcesSaved" : "insightSaveSources"))
                            Spacer()
                            if saving { ProgressView() } else if saved { Image(systemName: "checkmark") }
                        }
                    }.disabled(!canSave)
                        .accessibilityIdentifier("insightSaveSources")
                } footer: { Text(tr("insightGenerationPolicy")) }
                Section {
                    Text(tr("insightPrivacy")).font(.footnote)
                    Button(tr("insightClear"), role: .destructive) { confirmClear = true }.accessibilityIdentifier("insightClear")
                }
                if let error = feed.error { Section { ErrorNote(text: tr(error)) } }
            } else {
                Text(tr(model.state == nil ? "insightConnectDetail" : "insightUpdateGateway"))
            }
        }.disabled(saving).navigationTitle(tr("insightSources")).navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { if hasChanges { confirmLeave = true } else { dismiss() } } label: { Image(systemName: "chevron.left") }
                        .accessibilityLabel(tr("insightSourcesBackLabel")).accessibilityIdentifier("insightSourcesBack").disabled(saving)
                        .alert(tr("insightUnsavedTitle"), isPresented: $confirmLeave) {
                            Button(tr("insightSaveAndLeave")) { save(close: true) }.disabled(!canSave)
                            Button(tr("insightDiscardChanges"), role: .destructive) { dismiss() }
                            Button(tr("insightKeepEditing"), role: .cancel) {}
                        } message: { Text(tr("insightUnsavedDetail")) }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { save() } label: {
                        if saving { ProgressView() } else { Text(tr(saved ? "insightSavedShort" : "save")).fontWeight(.semibold) }
                    }.disabled(!canSave || (!hasChanges && !saved)).accessibilityIdentifier("insightSaveToolbar")
                }
            }
            .onAppear { load() }
            .onChange(of: preferences) { _, _ in saved = false }
            .onChange(of: model.state?.runId) { _, _ in loaded = false; load() }
            .onChange(of: model.contextID) { _, _ in loaded = false; load() }
            .onChange(of: model.state?.feed?.preferences) { _, next in
                if !saving && !hasChanges, let next, baseline?.matches(next) != true { loaded = false; load() }
            }
            .confirmationDialog(tr("insightClear"), isPresented: $confirmClear, titleVisibility: .visible) {
                Button(tr("insightClear"), role: .destructive) {
                    let context = model.contextID
                    guard let state = model.state else { return }
                    Task {
                        do { try await model.changeFeed("clear", expectedContext: context, runID: state.runId); loaded = false; load() }
                        catch { if model.contextID == context { self.error = error.localizedDescription } }
                    }
                }
            } message: { Text(tr("insightClearDetail")) }
    }

    private func load() {
        guard !loaded, let feed = model.state?.feed else { return }
        preferences = feed.preferences
        baseline = feed.preferences
        loaded = true; saved = false; error = nil
    }

    private func save(close: Bool = false) {
        guard canSave, let state = model.state else { return }
        let context = model.contextID, submitted = preferences
        saving = true; error = nil; saved = false
        Task {
            defer { saving = false }
            do {
                try await model.changeFeed("preferences", body: ["enabled": submitted.enabled, "sources": submitted.sources, "backend": submitted.backend, "language": submitted.language], expectedContext: context, runID: state.runId)
                guard model.contextID == context, model.state?.runId == state.runId else { return }
                guard model.state?.feed?.preferences.matches(submitted) == true else { throw MobileFailure.remote(409, "feed_settings_unconfirmed") }
                baseline = submitted; saved = true
                if close { dismiss() }
            } catch { if model.contextID == context { self.error = error.localizedDescription } }
        }
    }
}
