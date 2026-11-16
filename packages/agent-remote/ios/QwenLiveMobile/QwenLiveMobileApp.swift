import SwiftUI

private struct PollIdentity: Equatable {
    let contextID: UUID
    let isActive: Bool
}

@main
struct QwenLiveMobileApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var assistant = AssistantModel()
    @StateObject private var liveSettings = OmniLiveSettings()
    @Environment(\.scenePhase) private var scenePhase
    init() {
        UIWindow.appearance().tintColor = UIColor(named: "AccentColor")
    }
    var body: some Scene {
        WindowGroup {
            MainView().environmentObject(model).environmentObject(assistant).environmentObject(liveSettings)
                .tint(PersonalStyle.accent)
                .accentColor(PersonalStyle.accent)
                .preferredColorScheme(assistant.appearance == .system ? nil : assistant.appearance == .dark ? .dark : .light)
                .task(id: PollIdentity(contextID: model.contextID, isActive: scenePhase == .active)) {
                    if scenePhase == .active { await model.poll() }
                }
        }
    }
}

struct MainView: View {
    @EnvironmentObject private var model: AppModel
    private enum Destination { case assistant, workbench, feed, settings }
    @State private var destination = Destination.assistant
    @State private var requestedRoute: ConversationRoute?
    @State private var requestedPairingURL: URL?
    @State private var unavailable = false
    var body: some View {
        TabView(selection: $destination) {
            NavigationStack { OmniLiveView() }
                .tabItem { Label(tr("assistant"), systemImage: "sparkles") }.tag(Destination.assistant)
            WorkbenchView(showWorkbench: { destination = .workbench },
                          requestedRoute: $requestedRoute, requestedPairingURL: $requestedPairingURL)
                .tabItem { Label(tr("workbench"), systemImage: "laptopcomputer") }.tag(Destination.workbench)
            NavigationStack { PersonalFeedView(openActivity: openActivity, openDraft: openInsightDraft) }
                .tabItem { Label(tr("feed"), systemImage: "square.grid.2x2") }.tag(Destination.feed)
            NavigationStack { PersonalSettingsView(openActivity: openActivity, openDraft: openInsightDraft) }
                .tabItem { Label(tr("me"), systemImage: "person.crop.circle") }.tag(Destination.settings)
        }
        .alert(tr("conversationUnavailable"), isPresented: $unavailable) {
            Button(tr("done"), role: .cancel) {}
        } message: { Text(tr("activityUnavailable")) }
        .onOpenURL { url in
            destination = .workbench
            requestedPairingURL = url
        }
    }

    private func openActivity(_ link: ActivityLink) {
        guard let route = link.route(computerID: model.selectedComputerID, contextID: model.contextID, state: model.state) else {
            unavailable = true; return
        }
        destination = .workbench
        requestedRoute = route
    }

    private func openInsightDraft(_ card: InsightCard) {
        guard let state = model.state, model.prepareInsightDraft(card, expectedContext: model.contextID, runID: state.runId) else {
            unavailable = true; return
        }
        destination = .workbench
    }
}

struct StatusBadge: View {
    let status: String
    private var color: Color {
        switch status {
        case "completed": return PersonalStyle.accent
        case "waiting": return .orange
        case "failed", "interrupted": return .red
        case "cancelled": return .secondary
        default: return PersonalStyle.accent
        }
    }
    var body: some View {
        Text(tr(status)).font(.caption.weight(.medium)).foregroundStyle(color)
            .accessibilityIdentifier("status-\(status)")
    }
}

struct ErrorNote: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.red).textSelection(.enabled)
    }
}

extension View {
    func card() -> some View {
        self.frame(maxWidth: .infinity, alignment: .leading).padding()
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}
