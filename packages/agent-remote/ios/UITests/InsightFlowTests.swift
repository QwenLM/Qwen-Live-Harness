import XCTest

final class InsightFlowTests: XCTestCase {
    private func launch(_ fixture: String, language: String, dark: Bool = false) throws -> XCUIApplication {
        let file = try XCTUnwrap(Bundle(for: Self.self).url(forResource: fixture, withExtension: "json"), "Start the owned iOS fixtures before generating the project")
        let values = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: String])
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(\(language))"]
        if dark { app.launchArguments += ["-AppleInterfaceStyle", "Dark"] }
        app.launchEnvironment["QWEN_LIVE_PAIRING"] = try XCTUnwrap(values["link"])
        app.launch()
        app.tabBars.buttons[language == "en" ? "Workbench" : "工作台"].tap()
        app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["runSettings"].waitForExistence(timeout: 20))
        if dark {
            app.tabBars.buttons["我的"].tap()
            app.buttons["appearancePicker"].tap()
            app.buttons["深色"].tap()
        }
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 { if element.isHittable { return }; app.swipeUp() }
    }

    private func enable(_ app: XCUIApplication, language: String) {
        app.tabBars.buttons[language == "en" ? "Feed" : "动态"].tap()
        XCTAssertTrue(app.buttons["insightSetup"].waitForExistence(timeout: 10))
        capture(app, "Personal Feed before connecting context — " + language)
        app.buttons["insightSetup"].tap()
        let enabled = app.switches["insightEnable"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 10))
        enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(enabled.value as? String, "1")
        app.switches["insightSource-workbench"].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(app.switches["insightSource-workbench"].value as? String, "1")
        let codex = app.switches["insightSource-codex"]
        codex.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertEqual(codex.value as? String, "1")
        if language == "en" {
            app.buttons["insightLanguage"].tap()
            app.buttons["English"].tap()
        }
        capture(app, "Selected context sources — " + language)
        let save = app.buttons["insightSaveSources"]; reveal(save, in: app); save.tap()
        XCTAssertTrue(app.staticTexts[language == "en" ? "Saved on this computer" : "已保存到这台电脑"].waitForExistence(timeout: 15))
        app.buttons["insightSourcesBack"].tap()
    }

    func testGroundedInsightsWithoutArtifactsAndExplicitContinuationPreservesDraft() throws {
        let app = try launch("insights", language: "en")
        let input = app.descendants(matching: .any).matching(identifier: "taskInput").firstMatch
        input.tap(); input.typeText("Existing draft stays.")
        app.buttons["dismissTaskKeyboard"].tap()
        enable(app, language: "en")
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'insight-' AND label CONTAINS %@", "Give a memory a sense of progress")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'feed-'")).firstMatch.exists)
        capture(app, "Personal insights — English light")
        app.buttons["insightSources"].tap()
        XCTAssertEqual(app.switches["insightEnable"].value as? String, "1")
        XCTAssertEqual(app.switches["insightSource-codex"].value as? String, "1")
        app.buttons["insightSourcesBack"].tap()
        card.tap()
        XCTAssertTrue(app.staticTexts["Why this is here"].waitForExistence(timeout: 10))
        app.buttons["insightFavorite"].tap()
        capture(app, "Insight explanation and saved state")
        let evidence = app.staticTexts["Where this came from"]; reveal(evidence, in: app)
        XCTAssertTrue(evidence.exists)
        capture(app, "Verifiable quoted conversation evidence")
        let continueButton = app.buttons["insightContinue"]; reveal(continueButton, in: app); continueButton.tap()
        XCTAssertTrue(app.buttons["runSettings"].waitForExistence(timeout: 10))
        let draft = try XCTUnwrap(input.value as? String)
        XCTAssertTrue(draft.contains("Existing draft stays."))
        XCTAssertTrue(draft.contains("historical background"))
        XCTAssertTrue(draft.contains("changing decisions"))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-'")).firstMatch.exists)
        capture(app, "Continue creates a reviewable draft without executing")
    }

    func testChineseDarkInsightReadingAndRevokingSource() throws {
        let app = try launch("insights-zh", language: "zh-Hans", dark: true)
        enable(app, language: "zh-Hans")
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'insight-' AND label CONTAINS %@", "让记忆知道")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 30))
        capture(app, "个人动态 — 中文深色")
        app.buttons["insightSources"].tap()
        app.switches["insightSource-codex"].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        app.buttons["insightSourcesBack"].tap()
        XCTAssertTrue(app.buttons["继续编辑"].waitForExistence(timeout: 5))
        app.buttons["继续编辑"].tap()
        XCTAssertEqual(app.switches["insightSource-codex"].value as? String, "0")
        app.buttons["insightSourcesBack"].tap()
        app.buttons["放弃修改并返回"].tap()
        XCTAssertTrue(card.exists)
        app.buttons["insightSources"].tap()
        XCTAssertEqual(app.switches["insightSource-codex"].value as? String, "1")
        app.switches["insightSource-codex"].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        app.buttons["insightSourcesBack"].tap()
        app.buttons["保存并返回"].tap()
        XCTAssertTrue(app.buttons["insightSetup"].waitForExistence(timeout: 15))
        XCTAssertFalse(card.exists)
        app.buttons["insightSources"].tap()
        XCTAssertEqual(app.switches["insightEnable"].value as? String, "1")
        XCTAssertEqual(app.switches["insightSource-codex"].value as? String, "0")
        app.buttons["insightSourcesBack"].tap()
        capture(app, "撤销来源后移除关联卡片")
    }
}
