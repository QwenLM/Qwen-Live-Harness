import SwiftUI
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers
import ImageIO
import CryptoKit

struct ImageAttachment: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let mimeType: String
    let size: Int
    let sha256: String
}

struct ImageAttachmentStore {
    static let maxCount = 4
    static let maxBytes = 2 * 1024 * 1024
    static let maxImportBytes = 32 * 1024 * 1024
    let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("InputImages", isDirectory: true)
    }

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    func importImage(_ data: Data) throws -> ImageAttachment {
        guard !data.isEmpty, data.count <= Self.maxImportBytes else { throw MobileFailure.remote(413, "attachment_too_large") }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048
              ] as CFDictionary) else { throw MobileFailure.remote(400, "invalid_attachment") }
        let image = UIImage(cgImage: thumbnail)
        for quality in [0.85, 0.65, 0.45] {
            if let jpeg = image.jpegData(compressionQuality: quality), jpeg.count <= Self.maxBytes {
                return try saveJPEG(jpeg)
            }
        }
        throw MobileFailure.remote(413, "attachment_too_large")
    }

    private func saveJPEG(_ data: Data) throws -> ImageAttachment {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        let attachment = ImageAttachment(id: id, name: "photo-" + String(id.prefix(8)) + ".jpg",
                                         mimeType: "image/jpeg", size: data.count, sha256: Self.digest(data))
        try data.write(to: file(attachment), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return attachment
    }

    private func file(_ image: ImageAttachment) throws -> URL {
        guard UUID(uuidString: image.id) != nil, image.id == image.id.lowercased(),
              (1...Self.maxBytes).contains(image.size), ["image/jpeg", "image/png", "image/webp"].contains(image.mimeType) else {
            throw MobileFailure.remote(400, "invalid_attachment")
        }
        return directory.appendingPathComponent(image.id)
    }

    func read(_ image: ImageAttachment) throws -> Data {
        let url = try file(image)
        guard try url.resourceValues(forKeys: [.fileSizeKey]).fileSize == image.size else { throw MobileFailure.invalidResponse }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard data.count == image.size, Self.digest(data) == image.sha256 else { throw MobileFailure.invalidResponse }
        return data
    }

    func remove(_ image: ImageAttachment) { if let url = try? file(image) { try? FileManager.default.removeItem(at: url) } }

    func payload(_ images: [ImageAttachment]) throws -> [[String: String]] {
        guard images.count <= Self.maxCount else { throw MobileFailure.remote(400, "invalid_attachment") }
        return try images.map { ["id": $0.id, "name": $0.name, "mimeType": $0.mimeType, "data": try read($0).base64EncodedString()] }
    }
}

// A file representation bounds reads before loading a full-resolution photo.
private struct PickedImage: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let size = try received.file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard (1...ImageAttachmentStore.maxImportBytes).contains(size) else { throw MobileFailure.remote(413, "attachment_too_large") }
            return Self(data: try Data(contentsOf: received.file, options: .mappedIfSafe))
        }
    }
}

struct ImageAttachmentPicker: View {
    @Binding var images: [ImageAttachment]
    @Binding var importing: Bool
    let store: ImageAttachmentStore
    var disabled = false
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var photo: PhotosPickerItem?
    @State private var operation: UUID?
    @State private var loading: Task<Void, Never>?
    @State private var error: String?

    var body: some View {
        Menu {
            Button { showPhotos = true } label: { Label(tr("choosePhoto"), systemImage: "photo.on.rectangle") }
            Button { showFiles = true } label: { Label(tr("chooseImageFile"), systemImage: "folder") }
        } label: {
            Group { if importing { ProgressView() } else { Image(systemName: "plus").font(.system(size: 20)) } }
                .frame(width: 44, height: 44)
        }
        .disabled(disabled || importing || images.count >= ImageAttachmentStore.maxCount)
        .accessibilityLabel(tr("addImage")).accessibilityIdentifier("addImage")
        .photosPicker(isPresented: $showPhotos, selection: $photo, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image]) { result in
            switch result {
            case .success(let url):
                load {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard (1...ImageAttachmentStore.maxImportBytes).contains(size) else { throw MobileFailure.remote(413, "attachment_too_large") }
                    return try Data(contentsOf: url, options: .mappedIfSafe)
                }
            case .failure(let failure): error = failure.localizedDescription
            }
        }
        .onChange(of: photo) { _, selection in
            guard let selection else { return }
            load {
                guard let picked = try await selection.loadTransferable(type: PickedImage.self) else { throw MobileFailure.remote(400, "invalid_attachment") }
                return picked.data
            }
        }
        .onDisappear { operation = nil; loading?.cancel(); loading = nil; importing = false }
        .alert(tr("imageImportFailed"), isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button(tr("done"), role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }

    private func load(_ source: @escaping () async throws -> Data) {
        let id = UUID(); operation = id; importing = true
        loading?.cancel()
        loading = Task { @MainActor in
            defer { if operation == id { operation = nil; importing = false; photo = nil } }
            var imported: ImageAttachment?
            do {
                let data = try await source()
                try Task.checkCancellation()
                let imageStore = store
                let image = try await Task.detached { try imageStore.importImage(data) }.value
                imported = image
                try Task.checkCancellation()
                guard operation == id, !disabled, images.count < ImageAttachmentStore.maxCount else { store.remove(image); return }
                images.append(image)
                // A stale context can reject the binding write. Do not retain its file.
                if !images.contains(image) { store.remove(image) }
            } catch {
                if let imported { store.remove(imported) }
                if operation == id, !(error is CancellationError) { self.error = error.localizedDescription }
            }
        }
    }
}

struct ImageAttachmentStrip: View {
    let images: [ImageAttachment]
    let store: ImageAttachmentStore
    var remove: ((ImageAttachment) -> Void)? = nil
    @State private var preview: ImageAttachment?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(images) { image in
                    VStack(spacing: 4) {
                        Button { preview = image } label: {
                            if let data = try? store.read(image), let thumbnail = UIImage(data: data) {
                                Image(uiImage: thumbnail).resizable().scaledToFill().frame(width: 72, height: 72).clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                            } else { Image(systemName: "photo").frame(width: 72, height: 72) }
                        }.buttonStyle(.plain).accessibilityLabel(tr("previewImage")).accessibilityIdentifier("attachment-" + image.id)
                            .overlay(alignment: .topTrailing) {
                                if let remove {
                                    Button { remove(image) } label: {
                                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.65))
                                            .frame(width: 44, height: 44)
                                    }.buttonStyle(.plain).accessibilityLabel(tr("removeImage")).accessibilityIdentifier("removeImage")
                                        .offset(x: 8, y: -8)
                                }
                            }
                        Text(image.name).font(.caption2).lineLimit(1).frame(width: 80)
                    }
                }
            }.padding(.top, 8)
        }
        .sheet(item: $preview) { image in InputImagePreview(name: image.name) { try store.read(image) } }
    }
}

struct InputImagePreview: View {
    let name: String
    let load: () async throws -> Data
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Group {
                if let image { Image(uiImage: image).resizable().scaledToFit().accessibilityIdentifier("inputImagePreview") }
                else if let error { ErrorNote(text: error) }
                else { ProgressView() }
            }.padding().navigationTitle(name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("done")) { dismiss() } } }
                .task {
                    do {
                        let data = try await load(); try Task.checkCancellation()
                        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                                kCGImageSourceCreateThumbnailFromImageAlways: true,
                                kCGImageSourceCreateThumbnailWithTransform: true,
                                kCGImageSourceThumbnailMaxPixelSize: 4096
                              ] as CFDictionary) else { throw MobileFailure.invalidResponse }
                        image = UIImage(cgImage: thumbnail)
                    } catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
                }
        }
    }
}
