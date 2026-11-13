# Agent Remote iOS

[简体中文](README_ZH.md) · [Install the computer gateway](../README.md)

From the package directory, run `npm ci && npm run build` first. Then:

```sh
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

Select your development team and trusted iPhone, then Run. The display name is Agent Remote. Bundle ID, registered pairing schemes and Keychain identifiers intentionally retain the original values so upgrading preserves paired credentials. Do not rename them when installing over the original app.

The four native SwiftUI tabs are **Assistant → Workbench → Feed → Me**. Assistant shows up to three recent items from the connected workbench and device-local saved inputs, with a fixed text/voice/Live input bar. Text is saved locally and is not automatically dispatched. Speech-to-text requests microphone and speech permission only when tapped, requires on-device language support, and stops when leaving the page or when the app becomes inactive. Review and edit recognized text before saving; no recording is stored.

Feed displays actual task results, artifact references and locally saved inputs without category filters. Artifact previews retain the existing pinned HTTPS and offline-rendering checks. Me provides appearance and dictation-language preferences, saved-input management, saved task results, computer management and privacy information. Empty accounts show empty states, never sample outcomes. Omni conversations, Live calls, long-term memory, daily summaries and proactive notifications remain unconnected; Live explains its availability without starting a simulated call.

Workbench keeps its existing project lists and forms. Follow-ups retain the same owned agent session, with separate per-turn results, approvals and cancellation. Assistant and Feed links open the existing conversation only when computer, context, service run and task identities match. Drafts remain isolated by computer, service run and conversation. Upgrade the gateway together with the app for multi-turn support. Computer-service restarts do not restore old sessions.

Finished turns show a fixed run duration. Open **Artifacts** below a reply to preview images, Markdown or static HTML. Preview support requires the updated gateway and app; see the [gateway guide](../README.md#ios-app) for supported files and limits.

Simulator example:

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

For all TLS/UI tests, first run `npm run test:ios-fixture` in the package directory and leave it running, then regenerate the project. Restart the fixture for each test run. Without it the dependent tests explicitly skip. All automated tasks use fake agents; physical network, camera, signing and real backend acceptance are separate checks.

The client enforces HTTPS, rejects redirects and validates the paired certificate pin, hostname, expiry and server use. An ATS IPv4 exception permits private pinned certificates; it does not bypass these client checks. Tests reject wrong pins and plaintext requests.
