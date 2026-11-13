import XCTest

final class MobileFlowTests: XCTestCase {
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
        app.launch()
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

        app.terminate(); app.launchArguments = ["-AppleLanguages", "(en)"]; app.launch()
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
        app.segmentedControls.buttons[agent].tap()
        let input = app.textViews["taskInput"]; input.tap(); input.typeText(text)
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
        app.launch()
        app.buttons["connectMac"].tap()
        XCTAssertTrue(app.buttons["newConversation"].waitForExistence(timeout: 20))
        for (agent, decision, outcome) in [("Qwen Code", "allowPermission", "completed"), ("Codex", "denyPermission", "cancelled")] {
            app.buttons["newConversation"].tap()
            app.segmentedControls.buttons[agent].tap()
            let input = app.textViews["taskInput"]
            input.tap(); input.typeText("permission: \(agent) mobile approval smoke")
            app.buttons["sendTask"].tap()
            let rowPredicate = NSPredicate(format: "identifier BEGINSWITH 'task-' AND label CONTAINS %@", "permission: \(agent) mobile approval smoke")
            let button = app.buttons[decision]
            XCTAssertTrue(button.waitForExistence(timeout: 20))
            XCTAssertTrue(button.isEnabled)
            // Reopening the phone app must retain the same pending Mac request.
            app.terminate(); app.launchArguments = ["-AppleLanguages", "(en)"]; app.launch()
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

    func testPersonalAgentIsClearlyPlannedAndPreviewDoesNotOfferRealExecution() {
        let app = XCUIApplication()
        app.launchArguments = ["--uitesting", "-AppleLanguages", "(en)"]
        app.launch()
        app.tabBars.buttons["Assistant"].tap()
        XCTAssertTrue(app.staticTexts["Planned"].exists)
        app.buttons["previewPersonal"].tap()
        XCTAssertTrue(app.staticTexts["Concept preview · Sample data"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["sendFollowup"].exists)
        XCTAssertFalse(app.buttons["sendTask"].exists)
        capture(app, name: "Native Personal Agent concept preview")
    }

    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
