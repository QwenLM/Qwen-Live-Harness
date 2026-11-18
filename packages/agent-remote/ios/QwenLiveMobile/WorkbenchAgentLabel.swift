import SwiftUI

struct WorkbenchAgentLabel: View {
    let backendID: String
    let name: String
    @ScaledMetric(relativeTo: .caption) private var iconSize = 20.0
    private var tileSize: CGFloat { min(iconSize, 30) }

    var body: some View {
        HStack(spacing: 6) {
            icon.accessibilityHidden(true)
            Text(name)
        }
    }

    private var icon: some View {
        Color.clear.frame(width: tileSize, height: tileSize)
            .overlay {
                if let asset = Self.logoAsset(for: backendID) {
                    Image(asset)
                        .resizable()
                        .scaledToFit()
                        .frame(width: tileSize * 1.6, height: tileSize * 1.6)
                        .foregroundStyle(.primary)
                } else {
                    Image(systemName: "terminal")
                }
            }
    }

    static func logoAsset(for backendID: String) -> String? {
        switch backendID {
        case "qwen": "QwenCodeLogo"
        case "codex": "OpenAILogo"
        default: nil
        }
    }
}
