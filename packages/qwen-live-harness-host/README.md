# Qwen Live Harness Host Development Guide

[简体中文](README_ZH.md) | English

[Project overview](../../README.md) · [Configuration and features](../../docs/configuration.md) · [Daemon development](../qwen-live-harness/README.md)

Host is the macOS desktop component: UI, permissions, audio capture/playback, camera and screen capture, and global shortcuts. The daemon owns model connections, tools, background tasks, Memory, and Proactive. Host does not call model APIs directly or bundle Node.js or a daemon installer.

This guide is for desktop developers. For installation and everyday settings, use the [configuration guide](../../docs/configuration.md).

## Development environment

- macOS 12 or later, on Apple Silicon or Intel.
- Node.js 22.13+; Node 22 from the repository's `.nvmrc` is recommended.
- Xcode Command Line Tools or full Xcode, with working `xcrun --find clang++` and `xcrun --show-sdk-path`.
- Node.js headers for building native modules, including `node_api.h`. The build checks `NODE_INCLUDE_DIR` first, then the current Node.js installation's `include/node`, Homebrew, and `/usr/local`.

Host has its own `package-lock.json` and dependency tree. Root `npm ci` does not install Electron; install Host dependencies separately. Native Appshot is implemented in Objective-C++ and built as a universal arm64/x64 N-API module. See [`scripts/build.mjs`](scripts/build.mjs).

## Run from source

Run these commands from the repository root:

```sh
npm ci
npm --prefix packages/qwen-live-harness-host ci
npm run init
npm start
```

`npm run init` builds the daemon and saves configuration; it can keep an existing configuration. It does not install or start Host or change an installed application's desktop runtime registration.

`npm start` builds both packages, starts this checkout's daemon, then opens the source Host with local Electron when the daemon is ready. `Ctrl+C` stops both launcher-owned processes. Quit existing instances first to avoid mixing source and installed builds.

To see diagnostics from both sides:

```sh
npm start -- --debug
```

### Debug in two terminals

After installing dependencies and initializing, run these separately from the repository root:

```sh
# Terminal 1: build and start the daemon without opening an installed Host
npm run build
node packages/qwen-live-harness/dist/index.js --daemon-only --debug
```

```sh
# Terminal 2: build and open the source Host
npm --prefix packages/qwen-live-harness-host start -- --live-harness-debug
```

`--daemon-only` belongs to the daemon entry point, not the root development launcher. Use `--live-harness-debug` when launching Host directly; do not pass the daemon's `--debug` to Electron.

## Code map

| Entry point                                                      | Responsibility                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`src/main/index.ts`](src/main/index.ts)                         | Electron lifecycle, native windows, permissions, self-checks, shortcuts, and IPC routing        |
| [`src/main/daemon-connection.ts`](src/main/daemon-connection.ts) | Daemon connection, v9 handshake, media frames, and state synchronization                        |
| [`src/preload/index.ts`](src/preload/index.ts)                   | Restricted renderer bridge, audio engine, and camera engine                                     |
| [`src/renderer/live-view.ts`](src/renderer/live-view.ts)         | Main UI, permission page, and status bar; settings and subagent views are in the same directory |
| [`src/native/appshot.mm`](src/native/appshot.mm)                 | Foreground-window capture, accessibility text, and full-display capture                         |
| [`src/shared`](src/shared)                                       | Protocol parsing, IPC types, layout constants, and themes                                       |

Windows use `contextIsolation` and renderer sandboxing; `nodeIntegration`, navigation, and new windows are disabled by default. Extend explicit preload APIs and IPC messages, validating the sender, fields, lengths, and call epoch in the main process. Do not expose unrestricted Node.js or filesystem access to renderers.

### Layout and interaction

Geometry lives in [`overlay-geometry.ts`](src/shared/overlay-geometry.ts), [`subagents-geometry.ts`](src/shared/subagents-geometry.ts), and [`overlay-position.ts`](src/main/overlay-position.ts). Constrain visible content rather than the larger transparent canvas. [`subagents-windows.ts`](src/main/subagents-windows.ts) positions detail panels clear of the main UI and status bar.

Test dragging, screen edges, multiple displays, negative coordinates, scaling, display removal, and expanded settings/previews. Preserve saved positions during temporary layout adjustments; screenshots and state updates must not move the UI. Keep media and editing controls mounted so updates preserve focus, previews, and drafts. Theme changes use validated IPC and must not recreate streams or discard edits; user-facing options are in the [configuration guide](../../docs/configuration.md#theme-palette).

## Boundary with the daemon

Host connects over the loopback WebSocket endpoint `/live/host`. Discovery uses `~/.qwen-live-harness/run/daemon.json` (mode `0600`), containing the instance PID, nonce, and credentials. Do not log or share its contents.

The current protocol is **v9**, defined on both sides:

- Host: [`src/shared/protocol.ts`](src/shared/protocol.ts).
- Daemon: [`src/host/types.ts`](../qwen-live-harness/src/host/types.ts) and [`qwen-live-harness-host-coordinator.ts`](../qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts).

Validate message parsing and capability negotiation on both sides. Reject operations from ended call epochs, bind process control to the daemon nonce, and match playback acknowledgements to output IDs. Host sends device input and plays output; only the daemon manages API keys, model sessions, Realtime responses, audio commits, and tool results.

An installed Host starts the daemon from paths registered in `run/runtime.json`, using internal `--daemon-only` to avoid a launch loop. Ordinary disconnections reconnect without restarting processes. A CLI-launched Host belongs to that daemon instance and exits on its shutdown notification. See [`daemon-bootstrap.ts`](src/main/daemon-bootstrap.ts) and [`daemon-lifecycle.ts`](src/main/daemon-lifecycle.ts).

`End call` keeps the UI available; `Quit Qwen Live Harness` stops Host and daemon together. An unconfirmed shutdown keeps the UI open with an error and retry action. Released CLI and Host versions must match, not just their protocol numbers.

## Devices and permissions

| Visual mode | Required macOS permissions   |
| ----------- | ---------------------------- |
| Screen      | Microphone, Screen Recording |
| Camera      | Microphone, Camera           |

Unselected-source permissions must not block interaction. `Command+E` uses Electron `globalShortcut`, without Input Monitoring. Development Electron and released applications have separate macOS permission identities.

Built-in Appshot needs no separate capture application, CLI, MCP server, or runtime download. Screen On Demand, Live Feed, and visual monitors capture the full selected display, excluding Host windows; this path does not need Accessibility permission. On Demand retains an original PNG and encodes a transport-sized snapshot. Camera preview, live frames, and snapshots share one engine; hiding preview does not stop capture.

Host displays subagent progress/results and plays daemon-generated audio, reporting actual playback start/completion. Snapshot analysis, Live Feed, Proactive, and result scheduling belong to the daemon; see [Audio and visual input](../qwen-live-harness/README.md#audio-and-visual-input).

Subagents shows backend commands, arguments, working directories, and resources with Allow/Deny controls. Settings selects `permissionMode: "ask"` or `"allow-all"`; apply only daemon-confirmed changes. Backend approval and execution-start are distinct states, and approvals do not create persistent native grants. See [Spoken permissions and global approval mode](../qwen-live-harness/README.md#spoken-permissions-and-global-approval-mode) for policy and notification behavior.

Validate capture dimensions and transport limits separately: live frames are limited to `1920 × 1080` and `190 KiB`; snapshot assets to `8 MiB`. Camera snapshots prefer still-photo capture and fall back to video constraints; unsupported requests must fail explicitly. Check [`camera-engine.ts`](src/preload/camera-engine.ts), [`appshot-capture.ts`](src/main/appshot-capture.ts), and shared protocol limits together when changing encoding or dimensions.

### Audio and failure handling

Microphone input becomes mono, 16-bit, **16 kHz PCM** through an AudioWorklet. Model output is **24 kHz PCM**; playback uses the output device's AudioContext rate, not a forced system rate. Negotiated end markers use continuous streaming resampling. Preserve frame order, output IDs, and playback-start/completion acknowledgements: generation and forwarding are not proof of playback.

Playback has **10 ms scheduling headroom**, keeping queued fragments contiguous without adding a delay per chunk. Stop and speaker mute clear scheduled audio immediately. Bluetooth microphones may trigger macOS hands-free mode independently of model sample rate; include built-in/USB input with Bluetooth output in device tests.

Capture readiness waits up to 10 seconds for the device and first frame (readiness only when muted); AudioContext closure waits at most one second. Stop, mute, call changes, and quit cancel pending operations and release late-arriving resources. Timeouts end the call without a retry loop, leaving Settings, dragging, quit, and manual retry usable. Do not confuse audio faults with revoked permissions. See [`capture-readiness.ts`](src/main/capture-readiness.ts), [`audio-operation.ts`](src/preload/audio-operation.ts), and [`audio-engine.ts`](src/preload/audio-engine.ts).

## Logs and shared text

Host preferences and routine failure logs are stored under Electron `userData`, normally:

```text
~/Library/Application Support/qwen-live-harness-host/
├── overlay-position.json
├── language.json
├── theme.json
└── logs/
    ├── host-errors.log
    ├── host-errors.log.1
    ├── host-window-trace.jsonl     # debug only
    └── host-window-trace.jsonl.1
```

`host-errors.log` records allowlisted fault metadata even without debug, uses mode `0600`, and rotates at 1 MiB with one backup. Logging failures must not interrupt media or shutdown; see [`host-diagnostics.ts`](src/main/host-diagnostics.ts).

`--live-harness-debug` enables state/device/transport diagnostics and window traces. Traces contain bounded geometry and predefined state labels, not pixels, dialogue, or credentials; they rotate at 4 MiB with one backup. For movement bugs, compare content bounds and renderer offsets, not just native frame size.

Daemon model/media archives are separate and may contain sensitive prompts, Memory, tool data, audio, and images even after credential redaction. See [Run archives and offline inspection](../qwen-live-harness/README.md#run-archives-and-offline-inspection) for locations, inspection, and export.

Fixed UI strings use paired `en`/`zh-CN` entries in [`messages.ts`](../qwen-live-harness/src/i18n/messages.ts). Build aliases bundle shared messages, startup, and subagent modules; Host does not depend on an installed daemon package at runtime. Rebuild and test both packages after shared changes.

## Tests and packaging

Run Host checks from the repository root:

```sh
npm run lint:host
npm run typecheck:host
npm run test:host
npm run build:host
```

Root `npm test` does **not** include Host tests. Use `npm run lint:all` for both packages, and run root type checks and relevant daemon tests for shared/protocol/lifecycle changes. Automated checks do not replace real-device, permission, dragging, and signed-installation tests on macOS; record that environment in your PR.

Build local installers without publishing to GitHub or npm:

```sh
npm --prefix packages/qwen-live-harness-host run dist:mac:no-publish
```

Compiled files are in `dist/`, installers in `release/`. [`electron-builder.yml`](electron-builder.yml) defines App ID `com.alibaba.qwen-live-harness.host` and `/Applications/Qwen Live Harness Host.app`. Native modules are separately signed resources. Preserve ASAR integrity and Electron fuse restrictions; a successful build does not prove release signing or notarization.

### Release maintenance

The release entry point is [Qwen Live Harness Host Release](../../.github/workflows/qwen-live-harness-host-release.yml). Pushes to `main` run CI, relevant PRs run packaging dry runs, and a release is manually dispatched from `main`. The release version must match committed daemon and Host versions and their lockfiles. Public release and npm versions cannot be overwritten; `clobber` is only for unpublished drafts.

The stable flow builds and tests, signs with Developer ID, notarizes, creates a GitHub Release, synchronizes the OSS mirror, then publishes npm. Artifacts include arm64/x64 ZIP and DMG files, `Qwen-Live-Harness-Host-manifest.json`, and checksums. Version tags use `qwen-live-harness-host-vX.Y.Z`; the stable download feed is `qwen-live-harness-host-latest`. Drafts do not publish npm. Prereleases use the npm `preview` tag and do not update the stable Host feed.

The installer checks the version, manifest, SHA-256, bundle ID, Developer ID team `NF4574S59H`, `codesign --deep --strict`, and Gatekeeper. When changing signing, review [`build/entitlements.mac.plist`](build/entitlements.mac.plist) and preserve these checks and the renderer's restricted permissions.

The [OSS synchronization workflow](../../.github/workflows/sync-qwen-live-harness-host-to-oss.yml) uploads versioned ZIPs and manifests with `ossutil`, verifies public downloads, then updates the `latest` manifest. Its default public base URL is `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/qwen-live-harness-host`. The installer tries OSS before this repository's GitHub feed. OSS synchronization can be rerun independently; GitHub fallback requires the repository and Release to be accessible to the downloader.

Maintainers configure:

- Apple signing/notarization credentials: `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_P8`, and `APPLE_TEAM_ID`. See the workflow for alternative variables and encoding formats.
- OSS credentials: `ALIYUN_OSS_ACCESS_KEY_ID`, `ALIYUN_OSS_ACCESS_KEY_SECRET`, and the `production-release` environment. Optional bucket, endpoint, and public-base variables are documented in the synchronization workflow.
- npm [Trusted Publisher](https://docs.npmjs.com/trusted-publishers): bind `QwenLM/Qwen-Live-Harness`, workflow `qwen-live-harness-host-release.yml`, and environment `production-release`. The publishing job uses OIDC with `id-token: write`, not `NPM_TOKEN`; public-repository publications include provenance. The workflow pins Node/npm versions that support Trusted Publishing.

## License

[Apache License 2.0](../../LICENSE).
