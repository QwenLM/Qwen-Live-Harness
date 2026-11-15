import SwiftUI

struct ComposerBar<Attachment: View, Field: View, Actions: View>: View {
    @ViewBuilder let attachment: Attachment
    @ViewBuilder let field: Field
    @ViewBuilder let actions: Actions

    var body: some View {
        let row = HStack(alignment: .bottom, spacing: 2) {
            attachment
            field
                .font(.body).textFieldStyle(.plain).lineLimit(1...6)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.leading, 6)
            actions
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        let shape = RoundedRectangle(cornerRadius: 25, style: .continuous)
        if #available(iOS 26, *) {
            row.glassEffect(.regular, in: shape)
        } else {
            row.background(.regularMaterial, in: shape)
        }
    }
}

extension View {
    @ViewBuilder
    func bottomComposer<Bar: View>(@ViewBuilder content: () -> Bar) -> some View {
        let bar = content().padding(.horizontal, 16).padding(.vertical, 6)
        if #available(iOS 26, *) {
            safeAreaBar(edge: .bottom, spacing: 0) { bar }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) { bar.background(Color(uiColor: .systemBackground)) }
        }
    }
}
