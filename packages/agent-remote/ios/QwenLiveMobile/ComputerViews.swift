import SwiftUI

struct PairingForm: View {
    @EnvironmentObject private var model: AppModel
    @State private var scanner = false
    @FocusState private var inputFocused: Bool
    var onConnected: () -> Void = {}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image("BrandMark").renderingMode(.template).resizable().scaledToFit()
                    .frame(width: 72, height: 50).foregroundStyle(.tint).padding(.top, 20)
                    .accessibilityLabel("Agent Remote")
                VStack(alignment: .leading, spacing: 10) {
                    Text(tr(model.pairingTargetID == nil ? "pairTitle" : "repairComputer")).font(.largeTitle.bold())
                    Text(tr("pairSubtitle")).font(.body).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Label(tr("startOnComputer"), systemImage: "1.circle.fill").font(.headline)
                    Text("agent-remote pair").font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    Text(tr("sameWiFi")).font(.subheadline).foregroundStyle(.secondary)
                }.card()
                VStack(alignment: .leading, spacing: 16) {
                    Label(tr("pairPhone"), systemImage: "2.circle.fill").font(.headline)
                    Button { inputFocused = false; scanner = true } label: {
                        Label(tr("scanPairing"), systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                    }.buttonStyle(.bordered).controlSize(.large)
                    TextField(tr("pairingPlaceholder"), text: $model.pairingText, axis: .vertical)
                        .font(.system(.footnote, design: .monospaced)).lineLimit(3...5)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().focused($inputFocused)
                        .accessibilityIdentifier("pairingInput")
                    HStack {
                        Button(tr("paste"), systemImage: "doc.on.clipboard") { model.pairingText = UIPasteboard.general.string ?? "" }
                        Spacer()
                        Button {
                            inputFocused = false
                            Task { if await model.pair() { onConnected() } }
                        } label: {
                            if model.connecting { ProgressView().tint(.white) }
                            else { Text(tr("connect")) }
                        }.buttonStyle(.borderedProminent).controlSize(.large)
                            .disabled(model.pairingText.isEmpty || model.connecting).accessibilityIdentifier("connectMac")
                    }
                }.card()
                if let error = model.actionError { ErrorNote(text: error) }
                Label(tr("pairSecurity"), systemImage: "lock.shield").font(.footnote).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 650)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(tr("done")) { inputFocused = false }.accessibilityIdentifier("dismissPairingKeyboard")
            }
        }
        .sheet(isPresented: $scanner) {
            NavigationStack {
                QRScanner { code in model.pairingText = code; scanner = false }
                    .navigationTitle(tr("scanPairing"))
                    .toolbar { Button(tr("done")) { scanner = false } }
            }
        }
    }
}

struct ComputersView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let onPair: (UUID?) -> Void
    @State private var candidate: SavedComputer?
    @State private var confirmForget = false
    @State private var showRename = false
    @State private var nickname = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if model.computers.isEmpty {
                        ContentUnavailableView(tr("noComputers"), systemImage: "desktopcomputer", description: Text(tr("noComputersHint")))
                    }
                    ForEach(model.computers) { computer in
                        HStack(spacing: 12) {
                            Button {
                                if model.selectComputer(computer.id) { dismiss() }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(computer.displayName).font(.headline).foregroundStyle(.primary).lineLimit(1)
                                        Text(computer.connection.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer()
                                    if model.selectedComputerID == computer.id {
                                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                                    }
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("computer-row-\(computer.id)")
                                .accessibilityValue(tr(model.selectedComputerID == computer.id ? "currentComputer" : "switchComputer"))
                            Menu {
                                Button(tr("renameComputer"), systemImage: "pencil") {
                                    candidate = computer; nickname = computer.displayName; showRename = true
                                }
                                Button(tr("repairComputer"), systemImage: "qrcode") { onPair(computer.id) }
                                Button(tr("forgetComputer"), systemImage: "trash", role: .destructive) {
                                    candidate = computer; confirmForget = true
                                }
                            } label: { Image(systemName: "ellipsis.circle").padding(.vertical, 12) }
                                .accessibilityLabel(tr("computerOptions"))
                        }.padding(.vertical, 5)
                            .swipeActions {
                                Button(tr("forgetComputer"), role: .destructive) { candidate = computer; confirmForget = true }
                            }
                    }
                } footer: { Text(tr("switchComputerExplanation")) }
                Section {
                    Button { onPair(nil) } label: { Label(tr("addComputer"), systemImage: "plus.circle.fill") }
                        .accessibilityIdentifier("addComputer")
                }
                if let error = model.actionError { Section { ErrorNote(text: error) } }
            }
            .navigationTitle(tr("computers"))
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(tr("done")) { dismiss() } } }
            .alert(tr("forgetComputer"), isPresented: $confirmForget) {
                Button(tr("forgetComputer"), role: .destructive) { if let candidate { model.forgetComputer(candidate.id) } }
                Button(tr("cancel"), role: .cancel) {}
            } message: { Text(tr("forgetComputerExplanation")) }
            .alert(tr("renameComputer"), isPresented: $showRename) {
                TextField(tr("computerName"), text: $nickname)
                Button(tr("save")) { if let candidate { model.renameComputer(candidate.id, name: nickname) } }
                Button(tr("cancel"), role: .cancel) {}
            }
        }
    }
}
