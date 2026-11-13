import SwiftUI

private struct PollIdentity: Equatable {
    let contextID: UUID
    let isActive: Bool
}

@main
struct QwenLiveMobileApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            MainView().environmentObject(model).tint(Color(red: 0.12, green: 0.36, blue: 0.31))
                .task(id: PollIdentity(contextID: model.contextID, isActive: scenePhase == .active)) {
                    if scenePhase == .active { await model.poll() }
                }
        }
    }
}

struct MainView: View {
    private enum Destination { case assistant, workbench }
    @State private var destination = Destination.workbench
    var body: some View {
        TabView(selection: $destination) {
            NavigationStack { PersonalAgentView() }
                .tabItem { Label(tr("assistant"), systemImage: "sparkles") }.tag(Destination.assistant)
            WorkbenchView(showAssistant: { destination = .assistant }, showWorkbench: { destination = .workbench })
                .tabItem { Label(tr("workbench"), systemImage: "laptopcomputer") }.tag(Destination.workbench)
        }
    }
}

struct StatusBadge: View {
    let status: String
    private var color: Color {
        switch status {
        case "completed": return .green
        case "waiting": return .orange
        case "failed", "interrupted": return .red
        case "cancelled": return .secondary
        default: return .accentColor
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
