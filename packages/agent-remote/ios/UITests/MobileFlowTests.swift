import XCTest
import UIKit

final class MobileFlowTests: XCTestCase {
    func testLiveKeySetupPersistsLocallyAndCanBeDeletedWithoutStartingACall() {
        let app = XCUIApplication(); app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]; app.launch()
        app.buttons["assistantLive"].tap(); app.buttons["liveConfigure"].tap()
        let key = app.secureTextFields["liveAPIKey"], workspace = app.textFields["liveWorkspace"]
        XCTAssertTrue(key.waitForExistence(timeout: 10)); key.tap(); key.typeText("sk-fake-ios-ui-test-key")
        workspace.tap(); workspace.typeText("test-workspace")
        app.buttons["saveLiveConfiguration"].tap()
        XCTAssertTrue(app.staticTexts["Saved on this iPhone"].waitForExistence(timeout: 5))
        capture(app, name: "Own API key stored locally without displaying the saved value")
        app.navigationBars["Omni Live settings"].buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["Ready for Live"].waitForExistence(timeout: 5))
        app.terminate(); app.launchArguments = ["--uitesting-live-persist", "-AppleLanguages", "(en)"]; app.launch()
        app.buttons["assistantLive"].tap()
        XCTAssertTrue(app.buttons["liveStart"].waitForExistence(timeout: 10)); XCTAssertTrue(app.buttons["liveStart"].isEnabled)
        capture(app, name: "Omni Live ready after reopening without a paired Mac")
        app.buttons["Omni Live settings"].tap()
        XCTAssertTrue(app.secureTextFields["liveAPIKey"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["liveWorkspace"].value as? String, "test-workspace")
        app.buttons["deleteLiveKey"].tap(); app.sheets.buttons["Delete local API key"].tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["deleteLiveKey"])
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed)
    }

    func testArtifactPreviewsAndFinishedDuration() throws {
        guard let fixture = Bundle(for: Self.self).url(forResource: "artifacts", withExtension: "json"),
              let data = try? Data(contentsOf: fixture),
              let values = try? JSONSerialization.jsonObject(with: data) as? [String: String], let link = values["link"] else {
            throw XCTSkip("Start the artifact iOS fixture before generating the project.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launchEnvironment["QWEN_LIVE_PAIRING"] = link
        launchWorkbench(app); app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        app.buttons["newConversation"].tap()
        app.buttons["runSettings"].tap()
        app.segmentedControls.buttons["Codex"].tap()
        app.buttons["closeRunSettings"].tap()
        let input = app.descendants(matching: .any).matching(identifier: "taskInput").firstMatch
        input.tap(); input.typeText("artifacts: final outputs")
        app.buttons["sendTask"].tap()
        XCTAssertTrue(app.buttons["artifact-report.md"].waitForExistence(timeout: 20))
        capture(app, name: "Final artifacts in the conversation")
        app.buttons["artifact-report.md"].tap()
        XCTAssertTrue(app.staticTexts["Preview report"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Finished output"].exists)
        capture(app, name: "Markdown artifact preview")
        app.buttons["closePreview"].tap()
        app.buttons["artifact-index.html"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Preview page"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.staticTexts["Rendered HTML result"].exists)
        XCTAssertFalse(app.webViews.staticTexts["SCRIPT EXECUTED"].exists)
        capture(app, name: "Static HTML artifact preview")
        app.buttons["closePreview"].tap()
        app.buttons["artifact-output.png"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["imagePreview"].waitForExistence(timeout: 15))
        capture(app, name: "Image artifact preview")
        app.buttons["closePreview"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let elapsed = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'elapsed-'")).firstMatch
        XCTAssertTrue(elapsed.waitForExistence(timeout: 10))
        let duration = try XCTUnwrap(elapsed.value as? String)
        XCTAssertNotNil(duration.range(of: #"\d+:\d{2}:\d{2}"#, options: .regularExpression))
        let unchanged = NSPredicate { _, _ in elapsed.value as? String != duration }
        let expectation = XCTNSPredicateExpectation(predicate: unchanged, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 3), .timedOut)
        XCTAssertEqual(elapsed.value as? String, duration)
        capture(app, name: "Completed duration stays fixed")
        app.tabBars.buttons["Assistant"].tap()
        let recent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent-' AND label CONTAINS %@", "artifacts: final outputs")).firstMatch
        XCTAssertTrue(recent.waitForExistence(timeout: 10)); recent.tap()
        XCTAssertTrue(app.buttons["artifact-report.md"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["Feed"].tap()
        let report = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'feed-' AND label CONTAINS %@", "report.md")).firstMatch
        XCTAssertTrue(report.waitForExistence(timeout: 10))
        let describedReport = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'feed-' AND label CONTAINS %@ AND label CONTAINS %@", "report.md", "A project report with a page preview and image.")).firstMatch
        XCTAssertTrue(describedReport.waitForExistence(timeout: 20))
        capture(app, name: "Feed with generated task covers and descriptions")
        report.tap()
        XCTAssertTrue(app.staticTexts["Preview report"].waitForExistence(timeout: 10))
        capture(app, name: "Feed opens the owned real artifact")
    }
    func testMultipleComputersSwitchAndSurviveRelaunchWithoutNewPairing() throws {
        guard let fixture = Bundle(for: Self.self).url(forResource: "computers", withExtension: "json"),
              let data = try? Data(contentsOf: fixture),
              let computers = try? JSONSerialization.jsonObject(with: data) as? [[String: String]], computers.count == 2,
              let firstLink = computers[0]["link"], let secondLink = computers[1]["link"] else {
            throw XCTSkip("Start the two-computer iOS fixture before generating the project.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launchEnvironment["QWEN_LIVE_PAIRING"] = firstLink
        launchWorkbench(app)
        app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["activeComputerName"].label, "Test Mac A")
        sendAndWait(app, text: "permission: first computer", agent: "Qwen Code")

        app.buttons["computersButton"].tap()
        app.buttons["addComputer"].tap()
        let input = app.descendants(matching: .any).matching(identifier: "pairingInput").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap(); input.typeText(secondLink)
        if app.buttons["dismissPairingKeyboard"].exists { app.buttons["dismissPairingKeyboard"].tap() }
        app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["activeComputerName"].label, "Test Mac B")
        sendAndWait(app, text: "permission: second computer", agent: "Codex")

        app.terminate(); app.launchArguments = ["-AppleLanguages", "(en)"]; launchWorkbench(app)
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["activeComputerName"].label, "Test Mac B")
        app.buttons["computersButton"].tap()
        let first = computerRow(app, name: "Test Mac A"), second = computerRow(app, name: "Test Mac B")
        XCTAssertTrue(first.waitForExistence(timeout: 10)); XCTAssertTrue(second.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Saved computers"; screenshot.lifetime = .keepAlways
        add(screenshot)
        first.tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["activeComputerName"].label, "Test Mac A")
        XCTAssertTrue(taskRow(app, text: "permission: first computer").waitForExistence(timeout: 10))
        XCTAssertFalse(taskRow(app, text: "permission: second computer").exists)
        app.buttons["computersButton"].tap(); computerRow(app, name: "Test Mac B").tap()
        XCTAssertTrue(taskRow(app, text: "permission: second computer").waitForExistence(timeout: 20))
        XCTAssertFalse(taskRow(app, text: "permission: first computer").exists)
    }

    private func computerRow(_ app: XCUIApplication, name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'computer-row-' AND label CONTAINS %@", name)).firstMatch
    }
    private func taskRow(_ app: XCUIApplication, text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-' AND label CONTAINS %@", text)).firstMatch
    }
    private func sendAndWait(_ app: XCUIApplication, text: String, agent: String) {
        app.buttons["newConversation"].tap()
        let input = app.descendants(matching: .any).matching(identifier: "taskInput").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["sendTask"].isEnabled)
        if text == "permission: first computer" {
            capture(app, name: "Blank conversation with focused first-message composer")
            input.typeText(text)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertFalse(taskRow(app, text: text).exists)
            app.buttons["newConversationCard"].tap()
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            XCTAssertEqual(input.value as? String, text)
        }
        app.buttons["runSettings"].tap()
        XCTAssertTrue(app.buttons["workingFolderButton"].waitForExistence(timeout: 10))
        app.buttons["workingFolderButton"].tap()
        XCTAssertTrue(app.buttons["useWorkingFolder"].waitForExistence(timeout: 10))
        app.buttons["useWorkingFolder"].tap()
        XCTAssertTrue(app.segmentedControls.buttons[agent].waitForExistence(timeout: 10))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: app.segmentedControls.buttons[agent])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
        app.segmentedControls.buttons[agent].tap()
        app.buttons["closeRunSettings"].tap()
        if text != "permission: first computer" { input.tap(); input.typeText(text) }
        app.buttons["sendTask"].tap()
        XCTAssertTrue(app.staticTexts["status-completed"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["allowPermission"].exists)
        if text == "permission: first computer" {
            let input = app.descendants(matching: .any).matching(identifier: "conversationInput").firstMatch
            XCTAssertTrue(input.exists)
            XCTAssertFalse(app.tabBars.buttons["Workbench"].exists)
            XCTAssertFalse(app.buttons["sendFollowup"].isEnabled)
            capture(app, name: "Floating composer with keyboard dismissed")
            input.tap(); input.typeText("followup retained context\nKeep this draft in the same conversation.\nReview the result before making another change.")
            let send = app.buttons["sendFollowup"]
            XCTAssertTrue(send.isEnabled); XCTAssertTrue(send.isHittable)
            let keyboard = app.keyboards.firstMatch
            XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY + 1)
            capture(app, name: "Multiline composer above the keyboard")
            send.tap()
            let output = app.staticTexts.matching(NSPredicate(format: "identifier == 'taskOutput' AND label CONTAINS %@", "followup retained context")).firstMatch
            XCTAssertTrue(output.waitForExistence(timeout: 20))
            capture(app, name: "Native conversation with two turns")
        }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(taskRow(app, text: text).waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Workbench"].exists)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-' AND label CONTAINS %@", text)).count, 1)
    }

    func testPairChooseAgentSubmitAndApprove() throws {
        guard let fixture = Bundle(for: Self.self).url(forResource: "pairing", withExtension: "json"),
              let data = try? Data(contentsOf: fixture),
              let values = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let pairing = values["link"] else {
            throw XCTSkip("Start scripts/mobile-ui-fixture.mjs before generating the Xcode project to run the HTTPS flow.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launchEnvironment["QWEN_LIVE_PAIRING"] = pairing
        launchWorkbench(app)
        app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        for (agent, decision, outcome) in [("Qwen Code", "allowPermission", "completed"), ("Codex", "denyPermission", "cancelled")] {
            let entry = agent == "Codex" ? "newConversation-ui-fixture" : "newConversation"
            app.buttons[entry].tap()
            app.buttons["runSettings"].tap()
            app.segmentedControls.buttons[agent].tap()
            app.buttons["closeRunSettings"].tap()
            let input = app.descendants(matching: .any).matching(identifier: "taskInput").firstMatch
            input.tap(); input.typeText("permission: \(agent) mobile approval smoke")
            app.buttons["sendTask"].tap()
            let rowPredicate = NSPredicate(format: "identifier BEGINSWITH 'task-' AND label CONTAINS %@", "permission: \(agent) mobile approval smoke")
            let button = app.buttons[decision]
            XCTAssertTrue(button.waitForExistence(timeout: 20))
            XCTAssertTrue(button.isEnabled)
            // Reopening the phone app must retain the same pending Mac request.
            app.terminate(); app.launchArguments = ["-AppleLanguages", "(en)"]; launchWorkbench(app)
            let resumedRow = app.buttons.matching(rowPredicate).firstMatch
            XCTAssertTrue(resumedRow.waitForExistence(timeout: 20)); resumedRow.tap()
            XCTAssertTrue(app.buttons[decision].waitForExistence(timeout: 20))
            XCTAssertTrue(app.buttons[decision].isHittable)
            app.buttons[decision].tap()
            XCTAssertTrue(app.staticTexts["status-\(outcome)"].waitForExistence(timeout: 20))
            if outcome == "completed" { XCTAssertTrue(app.staticTexts["taskOutput"].exists) }
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
    }

    private func launchWorkbench(_ app: XCUIApplication) {
        app.launch()
        app.tabBars.buttons["Workbench"].tap()
    }

    func testPairingLinkFromAssistantOpensExistingWorkbench() throws {
        guard let fixture = Bundle(for: Self.self).url(forResource: "pairing-link", withExtension: "json"),
              let data = try? Data(contentsOf: fixture),
              let values = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let link = values["link"], let url = URL(string: link) else {
            throw XCTSkip("Start the local iOS fixture before generating the project.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["assistantInput"].waitForExistence(timeout: 10))
        app.open(url)
        XCTAssertTrue(app.buttons["connectMac"].waitForExistence(timeout: 10))
        app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["activeComputerName"].label, "Mac · Approval fixture")
    }

    func testPersonalTabsSaveLocallyWithoutInventingAnAssistantOrComputerResult() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.buttons["workingFolderButton"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["assistantInput"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.tabBars.buttons.allElementsBoundByIndex.map(\.label), ["Assistant", "Workbench", "Feed", "Me"])
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent-'")).count, 0)
        XCTAssertTrue(app.staticTexts["assistantEmpty"].exists)
        XCTAssertGreaterThanOrEqual(app.scrollViews.firstMatch.frame.width, app.frame.width - 1)
        XCTAssertFalse(app.staticTexts["Three recent updates"].exists)
        XCTAssertFalse(app.buttons["assistantSend"].exists)
        XCTAssertTrue(app.navigationBars.buttons["assistantLive"].isHittable)
        capture(app, name: "Empty assistant with the floating composer")
        let input = app.descendants(matching: .any)["assistantInput"]
        input.tap(); input.typeText("Keep this idea locally until the assistant is connected.")
        XCTAssertTrue(app.buttons["assistantSend"].isHittable)
        app.buttons["assistantSend"].tap()
        XCTAssertTrue(app.staticTexts["assistantReceipt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["assistantReceipt"].label.contains("No task has been dispatched"))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent-'")).count, 1)
        XCTAssertTrue(app.staticTexts["Three recent updates"].exists)
        XCTAssertFalse(app.staticTexts["assistantEmpty"].exists)
        XCTAssertFalse(app.buttons["assistantSend"].exists)
        XCTAssertFalse(app.buttons["sendFollowup"].exists)
        XCTAssertFalse(app.buttons["sendTask"].exists)
        capture(app, name: "Assistant saves an input locally without a fake reply")
        app.buttons["assistantLive"].tap()
        XCTAssertTrue(app.staticTexts["liveStatus"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["liveStart"].isEnabled)
        XCTAssertTrue(app.buttons["liveConfigure"].exists)
        app.buttons["closeLive"].tap()
        app.tabBars.buttons["Feed"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'feed-input.'")).firstMatch.waitForExistence(timeout: 5))
        capture(app, name: "Feed shows real locally saved input")
        app.tabBars.buttons["Me"].tap()
        XCTAssertTrue(app.buttons["savedInputs"].waitForExistence(timeout: 5))
        capture(app, name: "Personal settings")
        app.terminate(); app.launchArguments = ["-AppleLanguages", "(en)"]; app.launch()
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'recent-'")).count, 1)
        app.tabBars.buttons["Me"].tap(); app.buttons["savedInputs"].tap()
        XCTAssertTrue(app.staticTexts["Keep this idea locally until the assistant is connected."].waitForExistence(timeout: 5))
    }

    func testNativeThemeAcrossAppearanceChangesAndSheets() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launch()
        XCTAssertTrue(app.buttons["assistantVoice"].waitForExistence(timeout: 10))
        for appearance in ["Light", "Dark", "Light"] {
            app.tabBars.buttons["Me"].tap()
            app.buttons["appearancePicker"].tap()
            app.buttons[appearance].tap()
            capture(app, name: "System settings background and green tint " + appearance)
            app.tabBars.buttons["Assistant"].tap()
            assertGreenAccent(app.buttons["assistantLive"])
            capture(app, name: "Native assistant background and controls " + appearance)
            app.buttons["assistantLive"].tap()
            XCTAssertTrue(app.staticTexts["liveStatus"].waitForExistence(timeout: 5))
            capture(app, name: "Live sheet tint " + appearance)
            app.buttons["closeLive"].tap()
            assertGreenAccent(app.buttons["assistantLive"])
            app.tabBars.buttons["Workbench"].tap()
            capture(app, name: "Workbench tint after alert dismissal " + appearance)
        }
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func assertGreenAccent(_ element: XCUIElement) {
        guard let image = element.screenshot().image.cgImage else { XCTFail("Missing control screenshot"); return }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let sampled = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        XCTAssertTrue(sampled)
        var greenPixels = 0, bluePixels = 0
        for offset in stride(from: 0, to: pixels.count, by: 4) {
            let red = Double(pixels[offset]), green = Double(pixels[offset + 1]), blue = Double(pixels[offset + 2])
            if green > red * 1.15, green > blue * 1.05, green > 30 { greenPixels += 1 }
            if blue > green * 1.2, blue > red * 1.15, blue > 30 { bluePixels += 1 }
        }
        XCTAssertGreaterThan(greenPixels, 10, "Rendered controls must use the green accent")
        XCTAssertEqual(bluePixels, 0, "Default blue must not return after appearance or alert transitions")
    }
}
