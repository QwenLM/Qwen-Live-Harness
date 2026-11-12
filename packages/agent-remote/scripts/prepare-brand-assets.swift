// Export the approved artwork into the native platforms' asset formats.
// The artwork is kept intact; only transparent padding, size and the macOS
// rounded-square mask are applied here so every build uses the same geometry.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let manager = FileManager.default

func image(_ path: String) throws -> CGImage {
    guard let source = NSImage(contentsOf: root.appendingPathComponent(path)),
          let result = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw NSError(domain: "AgentRemoteBranding", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing branding image: \(path)"])
    }
    return result
}

func save(_ image: CGImage, _ path: String) throws {
    let target = root.appendingPathComponent(path)
    try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw NSError(domain: "AgentRemoteBranding", code: 2)
    }
    try png.write(to: target, options: .atomic)
}

let mark = try image("branding/agent-remote-symbol-v2.png")
let pixels = NSBitmapImageRep(cgImage: mark)
var left = pixels.pixelsWide, top = pixels.pixelsHigh, right = 0, bottom = 0
for y in 0..<pixels.pixelsHigh {
    for x in 0..<pixels.pixelsWide {
        if (pixels.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 {
            left = min(left, x); top = min(top, y)
            right = max(right, x); bottom = max(bottom, y)
        }
    }
}
guard left <= right && top <= bottom else { fatalError("The approved mark is empty") }
let bounds = CGRect(x: max(0, left - 2), y: max(0, top - 2),
                    width: min(pixels.pixelsWide, right + 3) - max(0, left - 2),
                    height: min(pixels.pixelsHigh, bottom + 3) - max(0, top - 2))
guard let trimmed = mark.cropping(to: bounds) else { fatalError("Cannot export brand mark") }
try save(trimmed, "ios/QwenLiveMobile/Assets.xcassets/BrandMark.imageset/BrandMark.png")
try save(trimmed, "macos/Resources/BrandMark.png")

let icon = try image("ios/QwenLiveMobile/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
guard icon.width == 1024 && icon.height == 1024 else { fatalError("iOS icon must be 1024 square") }
guard let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Cannot create macOS icon") }
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
context.addPath(CGPath(roundedRect: tile, cornerWidth: 180, cornerHeight: 180, transform: nil))
context.clip()
context.interpolationQuality = .high
context.draw(icon, in: tile)
guard let macIcon = context.makeImage() else { fatalError("Cannot export macOS icon") }
try save(macIcon, "macos/Resources/AppIcon.png")
print("Exported iOS/macOS brand marks and macOS icon from approved artwork.")
