import XCTest
import UIKit
@testable import QwenLiveMobile

@MainActor
final class ImageAttachmentTests: XCTestCase {
    private func store() -> ImageAttachmentStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("image-attachment-tests-" + UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return ImageAttachmentStore(directory: directory)
    }

    private func photo() -> Data {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 24), format: format).pngData { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2400, height: 24))
        }
    }

    func testImageImportNormalizesAndBoundsImagesAndKeepsBytesOutOfMetadata() throws {
        let store = store(), image = try store.importImage(photo())
        let data = try store.read(image), decoded = try XCTUnwrap(UIImage(data: data))
        XCTAssertEqual(image.mimeType, "image/jpeg"); XCTAssertTrue(image.name.hasSuffix(".jpg"))
        XCTAssertLessThanOrEqual(decoded.size.width, 2048); XCTAssertLessThanOrEqual(data.count, ImageAttachmentStore.maxBytes)
        XCTAssertEqual(data.count, image.size); XCTAssertEqual(ImageAttachmentStore.digest(data), image.sha256)
        let payload = try store.payload([image])
        XCTAssertEqual(payload.first?["data"], data.base64EncodedString())
        let metadata = String(decoding: try JSONEncoder().encode(image), as: UTF8.self)
        XCTAssertFalse(metadata.contains(data.base64EncodedString()))
        XCTAssertThrowsError(try store.payload(Array(repeating: image, count: 5)))
    }

    func testInvalidMissingAndChangedFilesCannotBeSent() throws {
        let store = store()
        XCTAssertThrowsError(try store.importImage(Data("not an image".utf8)))
        XCTAssertThrowsError(try store.importImage(Data(count: ImageAttachmentStore.maxImportBytes + 1)))
        let image = try store.importImage(photo())
        try Data("changed".utf8).write(to: store.directory.appendingPathComponent(image.id))
        XCTAssertThrowsError(try store.payload([image]))
        store.remove(image); XCTAssertThrowsError(try store.read(image))
    }

    func testImageOnlyCaptureAndUnfinishedImageDraftSurviveRelaunchAndDeleteTheirOwnedFiles() throws {
        let name = "image-capture-tests-" + UUID().uuidString, store = store()
        let preferences = UserDefaults(suiteName: name)!
        defer { preferences.removePersistentDomain(forName: name) }
        let model = AssistantModel(defaults: preferences, imageStore: store)
        let savedImage = try store.importImage(photo()), draftImage = try store.importImage(photo())
        model.setDraftImages([savedImage])
        let input = try XCTUnwrap(model.saveInput(source: .text))
        XCTAssertEqual(input.text, ""); XCTAssertEqual(input.images, [savedImage]); XCTAssertTrue(model.draftImages.isEmpty)
        model.setDraftImages([draftImage])
        let reopened = AssistantModel(defaults: preferences, imageStore: store)
        XCTAssertEqual(reopened.inputs, [input]); XCTAssertEqual(reopened.draftImages, [draftImage])
        XCTAssertNoThrow(try store.read(savedImage))
        reopened.deleteInput(input.id)
        XCTAssertThrowsError(try store.read(savedImage)); XCTAssertNoThrow(try store.read(draftImage))
        reopened.setDraftImages([]); XCTAssertThrowsError(try store.read(draftImage))
        XCTAssertTrue(AssistantModel(defaults: preferences, imageStore: store).inputs.isEmpty)
    }

    func testTextOnlyStorageMigratesAndMissingImagesNeverProduceASaveReceipt() throws {
        let name = "image-migration-tests-" + UUID().uuidString, store = store()
        let preferences = UserDefaults(suiteName: name)!
        defer { preferences.removePersistentDomain(forName: name) }
        let legacy = AssistantInput(id: UUID(), text: "Existing input", createdAt: Date(), source: .text)
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "draft": "Existing draft",
            "inputs": try JSONSerialization.jsonObject(with: JSONEncoder().encode([legacy])),
            "favorites": [], "appearance": "system", "dictationLanguage": "system"])
        preferences.set(data, forKey: AssistantModel.storageKey)
        let model = AssistantModel(defaults: preferences, imageStore: store)
        XCTAssertEqual(model.inputs, [legacy]); XCTAssertEqual(model.draft, "Existing draft"); XCTAssertTrue(model.draftImages.isEmpty)
        let image = try store.importImage(photo()); model.setDraftImages([image]); store.remove(image)
        XCTAssertNil(model.saveInput(source: .text)); XCTAssertEqual(model.draft, "Existing draft")
        XCTAssertEqual(model.inputs, [legacy]); XCTAssertEqual(model.draftImages, [image]); XCTAssertNotNil(model.error)
    }
}
