# Agent Remote iOS

The interface uses iOS system backgrounds and an adaptive dark-green accent in light and dark appearances. After a completed task has previewable artifacts, the gateway makes one additional Agent request to generate a `cover.svg` and a short description for Feed. Generation uses a separate temporary session, the completed result and artifact names, with a 60-second deadline. Follow-ups remain available while the cover is prepared. Covers use authenticated, offline previews and are held in gateway memory until restart. If generation fails, Feed shows the original artifact. This adds model usage through the selected Agent account. Update both gateway and app to use generated covers.

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

Tap **+** in Assistant, a new workbench conversation or a follow-up to choose an image from Photos or Files. You can preview and remove attachments before saving or sending, with or without text. Each input accepts up to four images. The app converts selected images (up to 32 MB each) to JPEG, with a maximum edge of 2048 pixels and 2 MB per attachment; original image metadata is not forwarded. Assistant keeps images locally with the saved input. Workbench sends actual image content over the paired HTTPS connection to an agent that advertises image input; update the gateway together with the app. An older gateway or unsupported agent cannot silently send only the text. Uploaded images remain available for preview during that gateway run (64 MB total); restarting the gateway clears its in-memory copies. Image files stay in the phone's app storage, separate from draft metadata, and are removed when their last saved input, draft or pending request is deleted or acknowledged. Unconfirmed retries retain the same image content and request ID.

Workbench keeps its existing project lists and forms. Follow-ups retain the same owned agent session, with separate per-turn results, approvals and cancellation. Assistant and Feed links open the existing conversation only when computer, context, service run and task identities match. Drafts remain isolated by computer, service run and conversation. Upgrade the gateway together with the app for multi-turn support. Computer-service restarts do not restore old sessions.

The **Working folder** row above each input shows the current computer folder. Tap it to browse shared roots, open subfolders, go to the parent folder, search the loaded folder names and confirm **Use this folder**. Selections are remembered separately for each computer and become the actual working directory of a new agent session. In an existing conversation, choosing a different folder opens a new-conversation form; the original session and its draft keep their folder. Assistant saves the chosen computer and folder with its device-local input without dispatching a task. Only directories shared through the computer app or `--project` can be browsed; symlinks cannot leave those roots. Older gateways still allow selecting their configured folders. After a gateway restart, a previously selected subfolder requires explicit reselection before sending, and drafts remain intact.

Finished turns show a fixed run duration. Open **Artifacts** below a reply to preview images, Markdown or static HTML. Preview support requires the updated gateway and app; see the [gateway guide](../README.md#ios-app) for supported files and limits.

Simulator example:

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

For all TLS/UI tests, first run `npm run test:ios-fixture` in the package directory and leave it running, then regenerate the project. Restart the fixture for each test run. Without it the dependent tests explicitly skip. All automated tasks use fake agents; physical network, camera, signing and real backend acceptance are separate checks.

The client enforces HTTPS, rejects redirects and validates the paired certificate pin, hostname, expiry and server use. An ATS IPv4 exception permits private pinned certificates; it does not bypass these client checks. Tests reject wrong pins and plaintext requests.
