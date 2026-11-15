# Agent Remote

[简体中文](README_ZH.md)

Send tasks from your iPhone to **Qwen Code / Codex CLI** on your computer. Follow progress and results, or request cancellation. The gateway defaults to **Qwen YOLO / Codex Full Access**, automatically answering remaining one-time permission requests. Accepted work continues when the phone app closes.

This directory is a standalone project containing the gateway, iOS app, macOS menu bar app, build tools, dependency lockfile, tests and installers. It does not require Qwen Live Harness, Omni, Electron, voice credentials or adjacent source directories.

## macOS app (recommended)

Install `release/Agent-Remote-0.1.0-universal.pkg`, or open the matching DMG and drag **Agent Remote** into Applications. Open the app, choose project folders, and start the service. The menu bar panel shows a pairing QR code, installed agents, connection status and task counts. On your iPhone, add this computer by scanning the code. Existing pairing and automatic approval remain in place.

The app supports macOS 13+ on Apple Silicon and Intel and bundles Node.js 22.22.2, npm, and gateway dependencies. The target Mac does not need Node, npm, Xcode or the original repository. Install and sign in to Qwen Code and/or Codex separately; the app discovers common Homebrew, nvm and user installation paths. Codex's ACP adapter may need an internet download on first use.

**Start after login** starts the menu bar app and gateway for the current user. launchd restarts the gateway after an unexpected exit. Closing the window or quitting the menu bar app leaves the gateway running; use **Stop service** to stop it. Disabling login startup affects the next login and keeps current work running. This is a user login service, not a pre-login system daemon. Sleep still suspends connectivity, and a gateway restart does not resume old tasks. Project changes require idle tasks and restart the service.

The app reuses `~/.qwen-live-harness/mobile/` when existing pairing is present; fresh installs use `~/.agent-remote/`. **Open logs** opens that private state directory. Install updates in the same Applications location, finish active tasks, then restart the service from the app to use its bundled runtime. Removing the app alone does not uninstall its gateway: stop the service and turn off login startup first. Pairing remains on disk.

Build and package on a Mac with Xcode command-line tools and Node.js 22.13+:

```sh
npm ci
npm run test:macos
npm run build:macos
npm run check:macos
npm run package:macos -- --skip-build
```

The build verifies pinned official Node downloads and produces universal binaries. `check:macos` relocates the complete app, uses fake agents and private credentials, and tests pairing, automatic approval, project changes, login configuration and launchd crash recovery. It does not call model accounts or change your real service.

Local builds default to ad hoc app signing. To keep the app and gateway signing identity stable across rebuilds, put the SHA-1 fingerprint of your Apple Development signing certificate in `.macos-signing-identity` next to this README. You can find it with `security find-identity -v -p codesigning`. This setting stays in your checkout. `AGENT_REMOTE_SIGN_IDENTITY` overrides it for a single build. macOS asks for consent when the app first accesses a protected folder such as Desktop.

The default installer is unsigned and may be blocked on another Mac. Public distribution requires Developer ID Application and Installer certificates and Apple notarization. Use `AGENT_REMOTE_SIGN_IDENTITY` and `AGENT_REMOTE_INSTALLER_IDENTITY` to select the distribution identities.

## Install on another computer

This package has not been published to the public npm registry. Use the local artifact rather than installing an unknown package with the same name.

On the development computer, from this directory:

```sh
npm ci
npm run bundle
```

Copy `release/agent-remote-0.1.0.tgz` to the target computer. It needs Node.js 22.13+ and a signed-in `qwen` and/or `codex` command available on PATH:

```sh
npm install -g ./agent-remote-0.1.0.tgz
agent-remote --project "/absolute/path/to/project"
```

The foreground gateway opens a private pairing page. Scan or paste the link in the app and connect. For cellular access, configure a public hostname or IPv4 address as described below; local addresses require the same local network or a reachable VPN. QR generation uses Node.js and requires neither Xcode nor Swift. The default port is 47421; allow inbound connections and keep the computer awake.

Only installed agents appear. Codex may download its ACP adapter through npm on first use. Execution uses the target computer's agent account and configuration.

## macOS background service

Stop an existing foreground gateway before installing the per-user service:

```sh
agent-remote service install --project "/absolute/path/to/project"
agent-remote pair
```

It starts immediately and when this user logs in. Closing the terminal does not stop it. It is not a pre-login system service and does not prevent sleep.

```sh
agent-remote status
agent-remote service status
agent-remote service stop
agent-remote service start
agent-remote service uninstall
```

Stopping ends the service and its owned agent work. Uninstalling also removes only this package's login item; both retain pairing credentials. Reinstall to change project configuration. Active tasks or another foreground gateway prevent replacement. Reinstall the service when a Node.js version manager changes the Node executable path.

Linux foreground operation requires OpenSSL on PATH; use your own service manager for background operation. Windows adaptation and validation remain incomplete. Physical-device/signing validation currently targets Mac + iPhone.

## Projects and permissions

```sh
agent-remote --project "/path/project-a" --project "/path/project-b"
agent-remote --project "/path/project-a" --ask
agent-remote --project "/path/project-a" --port 47422
```

- The phone chooses from the computer's configured project list. A working directory is not a filesystem sandbox; the agent and OS determine execution scope.
- Each new conversation creates an owned ACP session, without taking over an existing terminal chat. Follow-up messages reuse that exact session and retain its context. Each turn has its own request ID, result, approval and stop state; wait for a turn to finish or confirm its stop before continuing. Qwen requests `yolo`, Codex requests `agent-full-access`. Missing modes are logged; remaining one-time requests can still be answered automatically.
- `--ask` enables individual review. The default automatic policy applies only to sessions owned by this gateway and does not rewrite agent global settings.
- Request IDs deduplicate submissions; network errors do not automatically create another task. Cancellation needs backend confirmation.
- Up to four concurrent turns and 100 retained turns across conversations. Public progress/output is bounded. Reopening the phone app reconnects to live conversations; restarting the computer service does not restore old turns or sessions. An interrupted or expired agent session is never silently replaced or replayed.

## Pairing and upgrade compatibility

```sh
agent-remote pair
agent-remote pair --no-open
```

Codes are valid for fifteen minutes and are single-use. `pair` renews the code without restarting the service, interrupting work or revoking existing phone credentials.

For 5G/cellular access, set **Public hostname or IPv4** in the macOS app, or start/install the gateway with:

```sh
agent-remote --project "/path/project" --public-host remote.example.com
# Or persist it in the login service:
agent-remote service install --project "/path/project" --public-host remote.example.com
agent-remote pair
```

`AGENT_REMOTE_PUBLIC_HOST` is also supported at startup; `--public-host` takes precedence. Enter only a DNS hostname or IPv4 address, without a scheme, port or path. The configured address is included in the TLS certificate and preferred by both the menu bar QR code and CLI pairing page. Later `pair` commands reuse the running gateway's address without repeating the option. Local IPv4, `.local` and simulator addresses remain fallbacks. Without a configured public host, pairing keeps its local-address preference.

Public DNS endpoints using this gateway's private certificate may require an exact hostname exception in the iOS app's `NSExceptionDomains` configuration before rebuilding your own app; see [Apple's domain exception guidance](https://developer.apple.com/documentation/bundleresources/information-property-list/nsexceptionallowsinsecurehttploads). Keep the exception limited to that hostname rather than enabling global arbitrary loads. HTTPS, certificate pin, hostname and expiry validation remain mandatory. Public IPv4 addresses do not require a hostname-specific entry.

Point DNS/DDNS to the computer's reachable public IP. If behind a router, forward the displayed TCP port (47421 by default) to the computer on the same port and allow it through the firewall. The gateway does not configure routers, DDNS or tunnels. A hostname alone cannot provide connectivity through an unreachable NAT/CGNAT. VPN access likewise requires a route to the displayed address and port.

Changing the public host restarts an idle service from the macOS app; active tasks block the change. Adding a hostname or IP absent from the certificate renews the certificate, so pair the phone again using the new code. A stable DNS hostname keeps the pinned certificate valid across local IP changes. Clearing the setting returns to local pairing.

Fresh installs use `~/.agent-remote/`. Existing certificates or credentials in `~/.qwen-live-harness/mobile/` select the legacy directory in place. HTTPS API, pairing payloads, iOS bundle ID and Keychain identifiers remain compatible. Do not clear credentials during migration. Finish old work before stopping the previous gateway; live sessions cannot transfer between processes.

```sh
agent-remote --data-dir "/custom/private/directory" --project "/path/project"
```

`AGENT_REMOTE_DATA_DIR` is also supported. Use the same directory for subsequent `pair`, `status` and service commands.

The app validates certificate pin, address and expiry, storing credentials in Keychain. Address/certificate renewal may require pairing again. The private pairing page contains a one-time secret and is never served by the network API.

To revoke phones, stop the gateway and start once with `--reset-pairing`. This flag cannot be persisted in a login service because it would revoke devices every login.

## iOS app

Feed generates a task-specific `cover.svg` and short description after successful artifact collection, using one extra request through the selected Agent account. A separate temporary session has a 60-second deadline and leaves the original conversation available for follow-ups. Generated covers are immutable authenticated previews, retained in gateway memory until restart. Generation failure falls back to the original artifact. The iOS interface uses system backgrounds with an adaptive dark-green accent. Upgrade both gateway and app.

The installed app continues to work with the independent service. Building the new app requires Xcode and XcodeGen:

```sh
npm ci
npm run build
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

Choose your development team and iPhone for `QwenLiveMobile`, then Run. Internal project/bundle/Keychain identifiers retain their original values to preserve credentials; the display name is Agent Remote. Signing accounts, teams and device IDs are not committed.

Open **Computers** at the top left and **Add computer** to scan another computer's pairing code. Credentials stay in the phone's Keychain. Tap a saved computer to switch without scanning again. Rename, pair again or forget individual entries; reopening the app restores the last selection.

The native SwiftUI app opens **Workbench**, grouping conversations by project. Start a conversation with the compose button, choose a project and agent, then continue from the same conversation. Its history shows separate turns, permission requests and results; **Stop this turn** affects only that turn. Conversation drafts stay with their computer, conversation and service run. Update the computer gateway to enable follow-ups; older gateways remain usable for reviewing and starting individual tasks.

The native tabs are **Assistant → Workbench → Feed → Me**. Assistant shows the three latest workbench/local-input items and saves text or on-device dictation locally without submitting a task. Feed displays actual task results, artifact references and saved inputs. Me manages preferences, local data and computers. Workbench keeps its existing UI; task links validate computer, context and service-run ownership. Omni Live calls connect directly to DashScope with your own key; long-term memory, proactive notifications and Live task dispatch remain unconnected. No sample outcomes or simulated calls appear. See the [iOS guide](ios/README.md) for permissions and data behavior.

Drafts, agent/project choices and unconfirmed submissions are retained separately for each computer. Switching neither stops remote work nor replays old requests on another computer. The previous single-computer credential and pending submission migrate automatically. Re-pair only when its certificate or authorization becomes invalid. Forgetting removes that computer's phone records without stopping its tasks.

Use **Working folder** above an input to browse shared computer folders and their subdirectories. Confirming a folder sets the working directory of a new session and remembers the choice for that computer. Existing conversations retain their original folder; choosing another opens a blank conversation. Shared roots remain controlled by the computer app or `--project`. Folder APIs require the paired device and current gateway run, reject traversal and out-of-root symlinks, and revalidate selected subfolders before task admission. See the [iOS guide](ios/README.md) for local captures, older gateways and restart behavior.

The **+** attachment button selects images from Photos or Files in Assistant, new conversations and follow-ups. Preview or remove them before saving or sending; image-only requests are supported. Assistant saves images locally. Workbench sends up to four optimized JPEG images (2 MB each) as actual ACP image blocks to an image-capable agent, retaining exact bytes for unconfirmed retries. Both app and gateway need this update. Input-image previews use authenticated, run-bound HTTPS reads; image bytes are excluded from state polling and retained only in memory on the gateway (64 MB per run). See the [iOS guide](ios/README.md) for import limits and phone storage behavior.

Completed turns retain a fixed run duration. **Artifacts** below each reply previews images, Markdown and static HTML reported by the agent. Files must be inside the shared project folder (including resolved symlink targets); inline ACP images and embedded documents are also supported. Previews use the paired HTTPS connection and immutable snapshots, limited to 8 MB per file, 12 files / 16 MB per turn and 64 MB per service run. HTML scripts, external requests and navigation are disabled; text previews show at most 512,000 characters. Missing or out-of-project files show an explanation. Upgrade both the gateway and iOS app for previews; old services retain text-only results.

Computer tasks use direct HTTPS over a reachable local network, VPN or configured public endpoint. No internet relay or background push is provided.

## Development, verification and extraction

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run check:package
```

The package check builds and globally installs the actual tarball in isolation, verifying legacy pairing, QR renewal, Qwen/Codex, automatic approval and submission deduplication through HTTPS/ACP fixture children. It never calls personal model accounts.

```sh
npm run test:ios-fixture
```

Keep the fixture running, regenerate the Xcode project in `ios`, then run tests. Start a new fixture for every UI run: pairing consumes the single-use code. The fixture uses one hour for cold builds; the real gateway uses fifteen minutes. Temporary fixture credentials are ignored and removed on shutdown. These tests use fake agents.

To move the entire project into its own repository:

```sh
npm run export
```

Copy `release/agent-remote-source/` or extract `release/agent-remote-source.tar.gz`. It contains service, iOS/macOS sources, tests, lockfile, tools and a generated distribution copy of the root LICENSE, excluding dependencies, downloaded runtimes, user credentials and build caches. Run `npm ci && npm run build` anywhere.

In the parent repository, first run `npm ci --prefix packages/agent-remote`. The compatibility command `npm run mobile` starts this package while preserving the caller's project directory. Like Host, this package installs its dependencies independently and is not a root npm workspace.
