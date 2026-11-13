import SwiftUI

struct PersonalSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var assistant: AssistantModel
    let openActivity: (ActivityLink) -> Void
    @State private var showComputers = false
    @State private var showPairing = false
    @State private var pairAfterListDismisses = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "person.crop.circle").font(.system(size: 40, weight: .ultraLight)).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(tr("mySpace")).font(.headline)
                        Text(tr("settingsIntro")).font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 12)
            }.listRowBackground(Color.clear)
            Section(tr("preferences")) {
                Picker(tr("appearance"), selection: $assistant.appearance) {
                    ForEach(MobileAppearance.allCases) { Text($0.label).tag($0) }
                }.accessibilityIdentifier("appearancePicker")
                Picker(tr("dictationLanguage"), selection: $assistant.dictationLanguage) {
                    ForEach(DictationLanguage.allCases) { Text($0.label).tag($0) }
                }.accessibilityIdentifier("dictationLanguagePicker")
            }
            Section {
                NavigationLink { SavedInputsView() } label: {
                    HStack { Label(tr("savedInputs"), systemImage: "tray"); Spacer(); Text("\(assistant.inputs.count)").foregroundStyle(.secondary) }
                }.accessibilityIdentifier("savedInputs")
                NavigationLink { PersonalFeedView(openActivity: openActivity, favoritesOnly: true) } label: {
                    Label(tr("favorites"), systemImage: "bookmark")
                }
                Button { showComputers = true } label: {
                    HStack {
                        Label(tr("computers"), systemImage: "laptopcomputer").foregroundStyle(.primary)
                        Spacer(); Text("\(model.computers.count)").foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                }.accessibilityIdentifier("settingsComputers")
            }
            Section {
                NavigationLink { PersonalPrivacyView() } label: { Label(tr("privacyAndData"), systemImage: "hand.raised") }
                NavigationLink {
                    List {
                        Text("Agent Remote").font(.title2.weight(.semibold))
                        Text((Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "")
                        Text(tr("assistantServicePending")).foregroundStyle(.secondary)
                    }.navigationTitle(tr("about"))
                } label: { Label(tr("about"), systemImage: "info.circle") }
            } footer: { Text(tr("personalServicesPending")) }
            if let error = assistant.error { Section { ErrorNote(text: error) } }
        }
        .scrollContentBackground(.hidden).background(PersonalStyle.background)
        .navigationTitle(tr("me")).navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showComputers, onDismiss: {
            if pairAfterListDismisses { pairAfterListDismisses = false; showPairing = true }
        }) {
            ComputersView { id in
                model.preparePairing(for: id); pairAfterListDismisses = true; showComputers = false
            }
        }
        .sheet(isPresented: $showPairing, onDismiss: { model.cancelPairing() }) {
            NavigationStack {
                PairingForm { showPairing = false }
                    .navigationTitle(tr("addComputer")).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(tr("cancel")) { showPairing = false } } }
            }
        }
    }
}

private struct SavedInputsView: View {
    @EnvironmentObject private var assistant: AssistantModel
    @State private var selected: AssistantInput?
    var body: some View {
        List {
            if assistant.inputs.isEmpty { ContentUnavailableView(tr("savedInputsEmpty"), systemImage: "tray") }
            ForEach(assistant.inputs) { input in
                Button { selected = input } label: {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(input.text).foregroundStyle(.primary).lineLimit(2)
                        Text(input.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 5)
                }
            }
        }
        .navigationTitle(tr("savedInputs")).navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selected) { input in SavedInputDetail(inputID: input.id) }
    }
}

private struct PersonalPrivacyView: View {
    var body: some View {
        List {
            Section(tr("savedInputs")) { Text(tr("assistantLocalPrivacy")) }
            Section(tr("voiceInput")) { Text(tr("dictationPrivacy")) }
            Section(tr("personalMemory")) { Text(tr("personalServicesPending")) }
            Section(tr("computers")) { Text(tr("computerPrivacy")) }
            Section {
                Link(tr("openSystemSettings"), destination: URL(string: UIApplication.openSettingsURLString)!)
            }
        }.navigationTitle(tr("privacyAndData")).navigationBarTitleDisplayMode(.inline)
    }
}
