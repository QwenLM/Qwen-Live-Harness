# Agent Remote iOS

Feed is a personal reading space: single-column editorial cards connect your selected AI conversations, surface open questions and suggest next steps. Each card explains why it is relevant, includes verifiable dialogue excerpts, and can be bookmarked or brought into a Workbench draft for review before sending. The interface retains adaptive dark-green accents, light/dark appearance and Dynamic Type. Update both the gateway and the iOS app.

[简体中文](README_ZH.md) · [Install the computer gateway](../README.md)

From the package directory, run `npm ci && npm run build` first. Then:

```sh
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

Select your development team and trusted iPhone, then Run. The display name is Agent Remote. Bundle ID, registered pairing schemes and Keychain identifiers intentionally retain the original values so upgrading preserves paired credentials. Do not rename them when installing over the original app.

The four native SwiftUI tabs are **Assistant → Workbench → Feed → Me**. Assistant opens directly into Omni Live: tap **Start talking** to begin a voice conversation, or **Set up voice** if no key is configured. Opening the tab never starts recording. Settings are at the top right; model information, privacy and diagnostics are under **About voice conversations**. Leaving Assistant or putting the app in the background ends the call. Previously saved inputs remain under Me → Tasks & saved inputs; any old unsaved assistant draft can be reviewed and saved under **Me → Saved inputs**.

Open **Feed → Context sources** (also in **Me**) to enable automatic insights and choose Workbench, local Codex or local Qwen Code conversations, the analyzing Agent, and card language. All sources start disabled. Selected text excerpts go to the chosen Agent account’s model and use its quota. Browsers, other chat apps, Omni Live calls and system push notifications are not connected in this version. Cards synchronize inside the app while connected; the computer continues preparing them while its gateway runs.

Tap **Save** at the top right after changing sources. The page confirms the settings returned by the computer, and going back with unsaved changes offers Save or Discard. For a first trial, enable a source containing recent conversations and save; the empty Feed shows source counts, generation progress and the next time a model request is allowed. **Check for new insights** checks the current context without bypassing the limits below.

The gateway checks once a minute and requests interpretation only for changed context, at least 15 minutes apart and at most six times per rolling 24 hours. Each request may return zero to three cards; insufficient evidence produces no placeholder content. Failed attempts also count against the budget. Pull to refresh respects the same limits. Cards and bounded context persist privately in `personal-feed.json` under the gateway state directory. Removing a source cancels active generation and deletes its collected context and all cards citing it; **Clear insights and context** disables collection and deletes derived data without touching original transcripts or tasks.

Collection covers transcript files modified in the last 30 days: up to 40 recent JSONL files per CLI, the last 2 MiB of each file, and up to 80 dialogue messages per conversation. Stored context is limited to 80 conversations and roughly two million JSON characters. Each model request uses the latest 12 conversations with up to 6,000 text characters each. Excerpted or partially parsed context is marked in evidence. Only user/assistant text is imported; system prompts, reasoning, tool results and sidechain records are excluded. Common credential patterns are redacted, but this cannot identify all sensitive text. Quotes are checked against the supplied context; that validates attribution, not the model’s interpretation.

Task artifacts remain available in Workbench. The previous results/input list is under **Me → Tasks & saved inputs**, and existing task bookmarks are under **Saved task results**. Me also provides personal-card bookmarks, appearance and dictation preferences, computers and privacy information. Empty feeds contain no sample cards. Omni Live memory and task dispatch remain unconnected.

Tap **+** in the Workbench bottom input or a follow-up to choose an image from Photos or Files. You can preview and remove attachments before sending, with or without text. Each input accepts up to four images. The app converts selected images (up to 32 MB each) to JPEG, with a maximum edge of 2048 pixels and 2 MB per attachment; original image metadata is not forwarded. Workbench sends actual image content over the paired HTTPS connection to an agent that advertises image input; update the gateway together with the app. An older gateway or unsupported agent cannot silently send only the text. Uploaded images remain available for preview during that gateway run (64 MB total); restarting the gateway clears its in-memory copies. Image files stay in the phone's app storage, separate from draft metadata, and are removed when their last saved input, draft or pending request is deleted or acknowledged. Unconfirmed retries retain the same image content and request ID.

In Workbench, type directly in the bottom input and send to create a conversation; there is no separate new-conversation page. Tap **+** beside a project to select its folder and focus the same input. Tap the folder and agent above the input to change either. Switching tabs keeps the unsent draft on this iPhone. Once the computer confirms your first message and synchronizes the matching task, its conversation opens for follow-ups. Follow-ups retain the same owned agent session, with separate per-turn results, approvals and cancellation. Feed links validate computer, context, service run and task identities. Drafts remain isolated by computer, service run and conversation. Upgrade the gateway together with the app for multi-turn support. Computer-service restarts do not restore old sessions.

Workbench and conversation input bars use native Liquid Glass on iOS 26 and later. The Workbench microphone transcribes speech into editable task text; it does not send a task automatically. Microphone and speech permission are requested only when tapped, and recognition requires on-device language support. Leaving the page, switching computers or service runs, or making the app inactive stops dictation. Review the text before sending; no recording is stored.

Open **Working folder** from **Run settings** above the Workbench input, or from an existing conversation, to browse shared roots, open subfolders, go to the parent folder, search the loaded folder names and confirm **Use this folder**. Selections are remembered separately for each computer and become the actual working directory of a new agent session. In an existing conversation, choosing a different folder returns to the Workbench input to prepare a new task; the original session and its draft keep their folder. Only directories shared through the computer app or `--project` can be browsed; symlinks cannot leave those roots. Older gateways still allow selecting their configured folders. After a gateway restart, a previously selected subfolder requires explicit reselection before sending, and drafts remain intact.

Finished turns show a fixed run duration. Open **Artifacts** below a reply to preview images, Markdown or static HTML. Preview support requires the updated gateway and app; see the [gateway guide](../README.md#ios-app) for supported files and limits.

### Omni Live with your own key

Open **Me → Omni Live settings** or the settings button inside Live. Enter a DashScope API key, its workspace ID and region (Beijing or Singapore), then save once. Qwen3.8 uses the workspace-specific endpoint; use the ID from the same region as the key. The key is stored in the iPhone Keychain with `WhenUnlockedThisDeviceOnly`, without iCloud synchronization. It is never bundled with the app, sent to a computer gateway, or stored in preferences. Reopen settings to replace or delete it; deleting the local entry does not revoke the provider key.

Live needs no paired Mac. On **Start talking**, the app requests microphone permission, exchanges the saved key for a 60-second temporary key over system-validated TLS, and connects to `qwen3.8-omni-flash-realtime`. Session configuration is acknowledged before capture starts. If the audio engine stops during startup before any microphone input or reply playback, Live rebuilds its audio connections once within the original capture timeout; it never reconnects the conversation or replays audio. Diagnostics includes engine state, configuration-change and startup-restart counts, and fixed failure codes. Input is 16 kHz mono PCM16; output is streamed at 24 kHz with user/assistant subtitles. Mute stops audio uploads; end, leaving Assistant, backgrounding, audio interruption or connection failure releases capture and playback. The microphone meter shows actual captured signal; sustained absence of microphone data after connecting ends the call with a message. Connection diagnostics includes only status, audio format and frame counts; copying it excludes keys, audio and subtitles. Debug builds also retain this small status snapshot in the app cache for device troubleshooting. Audio/subtitles stay in memory only. Camera, screen sharing, tools and durable memory are not connected. A network failure ends the call; reconnect explicitly to start a new conversation.

Simulator example:

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

For all TLS/UI tests, first run `npm run test:ios-fixture` in the package directory and leave it running, then regenerate the project. Restart the fixture for each test run. Without it the dependent tests explicitly skip. All automated tasks use fake agents; physical network, camera, signing and real backend acceptance are separate checks.

The client enforces HTTPS, rejects redirects and validates the paired certificate pin, hostname, expiry and server use. An ATS IPv4 exception permits private pinned certificates; it does not bypass these client checks. Tests reject wrong pins and plaintext requests.
