# Agent Remote iOS

[简体中文](README_ZH.md) · [Install the computer gateway](../README.md)

From the package directory, run `npm ci && npm run build` first. Then:

```sh
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

Select your development team and trusted iPhone, then Run. The display name is Agent Remote. Bundle ID, registered pairing schemes and Keychain identifiers intentionally retain the original values so upgrading preserves paired credentials. Do not rename them when installing over the original app.

The app uses native SwiftUI tabs, navigation, lists and forms. Workbench groups conversations by project; follow-ups retain the same owned agent session, with separate per-turn results, approvals and cancellation. Drafts are isolated by computer, service run and conversation. Assistant is a planned feature with a read-only, clearly labeled concept preview; persistent personal memory and proactive push remain unimplemented. Upgrade the gateway together with the app for multi-turn support. Computer-service restarts do not restore old sessions.

Finished turns show a fixed run duration. Open **Artifacts** below a reply to preview images, Markdown or static HTML. Preview support requires the updated gateway and app; see the [gateway guide](../README.md#ios-app) for supported files and limits.

Simulator example:

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

For all TLS/UI tests, first run `npm run test:ios-fixture` in the package directory and leave it running, then regenerate the project. Restart the fixture for each test run. Without it the dependent tests explicitly skip. All automated tasks use fake agents; physical network, camera, signing and real backend acceptance are separate checks.

The client enforces HTTPS, rejects redirects and validates the paired certificate pin, hostname, expiry and server use. An ATS IPv4 exception permits private pinned certificates; it does not bypass these client checks. Tests reject wrong pins and plaintext requests.
