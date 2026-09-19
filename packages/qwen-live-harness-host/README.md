# Qwen Live Harness Host Development Guide

[简体中文](README_ZH.md) | English

[Project overview](../../README.md) · [Configuration and features](../../docs/configuration.md) · [Daemon development](../qwen-live-harness/README.md)

Host is the macOS desktop component of Qwen-Live-Harness. It provides the UI, system permissions, microphone, speakers, camera, screen capture, and global shortcut. The daemon owns the main Omni session, tool scheduling, background Harness tasks, Memory, and Proactive. Host does not call model APIs directly and does not bundle Node or the daemon installer.

This guide is for desktop developers. For installation, input selection, memory settings, and user configuration, see [Configuration and features](../../docs/configuration.md).

## Development environment

- macOS 12 or later, on Apple Silicon or Intel.
- Node.js 22.13+; Node 22 from the repository's `.nvmrc` is recommended.
- Xcode Command Line Tools or full Xcode, with working `xcrun --find clang++` and `xcrun --show-sdk-path`.
- Node native development headers, including `node_api.h`. The build checks `NODE_INCLUDE_DIR` first, then the current Node installation's `include/node`, Homebrew, and `/usr/local`.

Host has its own `package-lock.json` and dependency tree. Root `npm ci` does not install Electron; install Host dependencies separately. Native Appshot is implemented in Objective-C++ and built as a universal arm64/x64 N-API module. See [`scripts/build.mjs`](scripts/build.mjs).

## Run from source

Run these commands from the repository root:

```sh
npm ci
npm --prefix packages/qwen-live-harness-host ci
npm run init
npm start
```

`npm run init` builds the daemon and opens the source initialization wizard. It saves configuration but does not download, install, or launch Host, or change an installed application's desktop runtime registration. You can keep existing configuration.

`npm start` builds both packages, starts this checkout's daemon, waits for readiness, and opens the source Host with local Electron. `Ctrl+C` cleans up both processes it started. Quit any running daemon or Host first to avoid mixing installed and source instances.

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

Main and subagent windows use `contextIsolation` and renderer sandboxing, with `nodeIntegration` disabled. Navigation and new windows are rejected by default. Add capabilities through explicit preload APIs and IPC messages. The main process validates the sending window, fields, lengths, and call epoch; never give renderers arbitrary Node execution or filesystem access.

### Layout and interaction

Geometry constants live in [`overlay-geometry.ts`](src/shared/overlay-geometry.ts); native position constraints live in [`overlay-position.ts`](src/main/overlay-position.ts). The transparent window canvas is not the same boundary as its visible content: constrain the initialization page, main UI, preview, and settings using their respective visible regions.

When changing layout, test screen edges, multiple displays, negative coordinates, scaling, display removal, and expanded settings/previews. Temporary repositioning must not overwrite saved user positions. State updates and snapshots must not move windows. Keep media and editing controls mounted so subtitle updates do not discard focus, previews, or drafts. [`subagents-windows.ts`](src/main/subagents-windows.ts) manages subagent panels; expanded details must not cover the main UI or status bar.

The Pebble UI uses a 234 × 194 px interaction card with persistent call controls and a task summary. Settings appear beside the card; the task summary opens the task window. Terminal sessions, instruction deliveries, session reports, searches, visual analyses, and monitors have their own status and detail views.

Iris is the default palette. On connection or reconnection, Host reads top-level `themeColor` from the configuration path supplied by the authenticated daemon. Supported values are `iris`, `clay`, `sage`, `tide`, `graphite`, `rose`, and `berry`; missing or invalid values use Iris without affecting calls. Light/dark/system appearance is independently persisted. See the [configuration guide](../../docs/configuration.md#theme-palette).

## Boundary with the daemon

Host connects over the loopback WebSocket endpoint `/live/host`. Its default discovery file is `~/.qwen-live-harness/run/daemon.json`, with mode `0600`; it contains the instance PID, nonce, and connection credentials. Do not print or share its contents.

The current protocol is **v9**, defined on both sides:

- Host: [`src/shared/protocol.ts`](src/shared/protocol.ts).
- Daemon: [`src/host/types.ts`](../qwen-live-harness/src/host/types.ts) and [`qwen-live-harness-host-coordinator.ts`](../qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts).

When changing messages, check parsing and capability negotiation on both sides. Media and session operations must not cross into an ended epoch. Process-level control is bound to the daemon instance nonce; playback acknowledgements also match an output ID. The daemon owns the model name, API key, session settings, and tool results. Host submits device input and plays output; it never creates Realtime responses or commits model input audio buffers directly.

An installed Host can start the daemon using the Node path, CLI path, and working directory registered in `run/runtime.json`. It uses the internal `--daemon-only` option to avoid a launch loop. Ordinary disconnections reconnect the transport rather than indefinitely restarting processes. A CLI-launched Host receives the corresponding discovery path and owner identity; it shuts down on the matching daemon instance's exit notification.

`End call` ends the interaction and leaves the desktop UI available. `Quit Host` coordinates shutdown of the application; if cleanup is not confirmed, the UI retains an error and retry action. See [`daemon-bootstrap.ts`](src/main/daemon-bootstrap.ts) and [`daemon-lifecycle.ts`](src/main/daemon-lifecycle.ts). Released CLI and Host versions must match; sharing a protocol version is not sufficient for mixing releases.

## Devices and permissions

| Visual mode        | Required macOS permissions   |
| ------------------ | ---------------------------- |
| Screen + On Demand | Microphone, Screen Recording |
| Screen + Live Feed | Microphone, Screen Recording |
| Camera             | Microphone, Camera           |

Permissions for an unselected source must not block interaction. The default `Command+E` shortcut uses Electron `globalShortcut` and does not require Input Monitoring. macOS manages development Electron and released-app permissions separately; verify the actual application identity being run.

Appshot is a module built into Host, not an external capture application, CLI, MCP, or runtime download. Screen On Demand, Live Feed, and visual Proactive monitors all capture the entire selected display and exclude Host windows. On Demand saves the native PNG asset; its encoded snapshot follows the configured resolution and transport limits. No Accessibility permission is needed for this full-display path. The same camera engine provides preview, live frames, and snapshots. Hiding its preview does not stop capture.

The daemon sends an On Demand snapshot to its read-only visual-analysis worker and returns that worker's text evidence to the main conversation. Host presents its progress and result in Subagents; it does not call the model itself. Live Feed and Proactive use their own input paths. See [Configuration and features](../../docs/configuration.md) for sources, modes, resolution, and capability boundaries.

Validate capture dimensions separately from protocol limits. Live frames are currently limited to `1920 × 1080` and `190 KiB` per frame; snapshot assets are limited to `8 MiB`. A larger configured capture size does not guarantee that those pixels survive live transmission. Native camera snapshots prefer still-photo capture and fall back to video constraints where possible; unsupported requests must fail explicitly. When changing dimensions or encoding, check [`camera-engine.ts`](src/preload/camera-engine.ts), [`appshot-capture.ts`](src/main/appshot-capture.ts), and shared protocol limits together.

### Audio and failure handling

An AudioWorklet converts microphone input to mono, 16-bit, 16 kHz PCM. The daemon requests **24 kHz PCM** from the model, and Host uses the same rate to decode it. Playback uses an AudioContext at the output device's actual sample rate, not a forced system rate. Connections with negotiated end markers use continuous streaming resampling and wait until the corresponding output has actually played. Preserve frame order, output IDs, and playback-complete acknowledgements.

Playback uses **10 ms scheduling headroom** and preserves the PCM stream's playback rate. Fragments already queued remain contiguous; the delay is not added to each chunk. Stop or mute clears scheduled audio immediately. Preparing a model response, forwarding audio, and the device actually playing it are distinct states; notification delivery depends on the matching playback acknowledgements.

Enabling a Bluetooth headset's own microphone may switch macOS to a hands-free profile; this is separate from the model output sample rate. Test built-in/USB microphone input together with Bluetooth output. Forcing a device sample rate does not solve operating-system audio routing.

Capture startup, device switching, and audio recovery use bounded waits. The main process waits up to 10 seconds for device readiness and the first input frame; muted input requires readiness only. Closing an AudioContext waits at most one second. Stop, mute, call changes, and quit cancel stale operations. Release late media streams and AudioContexts; cancellation must not falsely signal readiness or become a new playback error.

Audio timeout ends the current call but preserves the UI, Settings, dragging, and Quit; it does not immediately retry in a loop. Users can choose an input device and retry with Start or `Command+E`. Technical audio faults do not revoke system permissions; genuine missing permissions take precedence in the UI. See [`capture-readiness.ts`](src/main/capture-readiness.ts), [`audio-operation.ts`](src/preload/audio-operation.ts), and [`audio-engine.ts`](src/preload/audio-engine.ts).

## Logs and shared text

Host preferences and routine failure logs are stored under Electron `userData`, normally:

```text
~/Library/Application Support/qwen-live-harness-host/
├── overlay-position.json
├── language.json
├── theme.json
└── logs/
    ├── host-errors.log
    └── host-errors.log.1
```

Selected failure events are recorded even without debug. Logs contain allowlisted error codes, stages, epochs, and related metadata. Files use mode `0600`, rotate at 1 MiB, and retain the current file plus one backup. Logging failures must not interrupt media or shutdown. See [`host-diagnostics.ts`](src/main/host-diagnostics.ts).

`--live-harness-debug` records Host state, device, and frame-transport diagnostics. The daemon's `--debug` archives the five model-connection kinds—main, Monitor, search, visual analysis, and notification speech—plus runtime/control events under `<dataDir>/debug/run-*`. Those archives include private prompts, Memory context, tools, and media; credential redaction does not remove secrets inside audio or images. Per-Monitor media archives are separate. See [Run archives and offline inspection](../qwen-live-harness/README.md#run-archives-and-offline-inspection) for verification/export without executing recorded tasks, and [Configuration and features](../../docs/configuration.md) for user-facing options and data locations.

Fixed UI strings are centralized in [`packages/qwen-live-harness/src/i18n/messages.ts`](../qwen-live-harness/src/i18n/messages.ts), with paired `en` and `zh-CN` entries. Host bundles shared messages, startup, and subagent modules through build aliases rather than depending on an installed daemon npm package at runtime. Rebuild and verify both packages after changing shared files.

## Tests and packaging

Run Host checks from the repository root:

```sh
npm --prefix packages/qwen-live-harness-host run typecheck
npm --prefix packages/qwen-live-harness-host test
npm run build:host
```

For protocol, shared-text, or lifecycle changes, also run relevant daemon tests and root type checks. Automated tests cover protocols, layout, media clocks, timeouts, and shutdown. Real devices, permission dialogs, dragging, and signed installation still require macOS testing; document the verification environment in your PR.

Build local installers without publishing to GitHub or npm:

```sh
npm --prefix packages/qwen-live-harness-host run dist:mac:no-publish
```

Compiled files are in `dist/`, installers in `release/`. [`electron-builder.yml`](electron-builder.yml) sets App ID `com.alibaba.qwen-live-harness.host`, product name `Qwen Live Harness Host`, and the release installation path `/Applications/Qwen Live Harness Host.app`. Native modules are separate signed resources. Preserve ASAR integrity and Electron fuse restrictions. A successful build is not a substitute for release signing and notarization checks.

### Release maintenance

The release entry point is [Qwen Live Harness Host Release](../../.github/workflows/qwen-live-harness-host-release.yml). Pushes to `main` run CI, relevant PRs run packaging dry runs, and a release is manually dispatched from `main`. The release version must match committed daemon and Host versions and their lockfiles. Public release and npm versions cannot be overwritten; `clobber` is only for unpublished drafts.

The stable flow builds and tests, signs with Developer ID, notarizes, creates a GitHub Release, synchronizes the OSS mirror, then publishes npm. Artifacts include arm64/x64 ZIP and DMG files, `Qwen-Live-Harness-Host-manifest.json`, and checksums. Version tags use `qwen-live-harness-host-vX.Y.Z`; the stable download feed is `qwen-live-harness-host-latest`. Drafts do not publish npm. Prereleases use the npm `preview` tag and do not update the stable Host feed.

The installer verifies version, manifest, SHA-256, bundle ID, Developer ID team `NF4574S59H`, `codesign --deep --strict`, and Gatekeeper. Review [`build/entitlements.mac.plist`](build/entitlements.mac.plist) when maintaining signing. Do not expand renderer privileges or bypass these checks.

The [OSS synchronization workflow](../../.github/workflows/sync-qwen-live-harness-host-to-oss.yml) uploads versioned ZIPs and manifests with `ossutil`, verifies public downloads, then updates the `latest` manifest. Its default public base URL is `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/qwen-live-harness-host`. The installer tries OSS before this repository's GitHub feed. OSS synchronization can be rerun independently; GitHub fallback requires the repository and Release to be accessible to the downloader.

Maintainers configure:

- Apple signing/notarization credentials: `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_P8`, and `APPLE_TEAM_ID`. See the workflow for alternative variables and encoding formats.
- OSS credentials: `ALIYUN_OSS_ACCESS_KEY_ID`, `ALIYUN_OSS_ACCESS_KEY_SECRET`, and the `production-release` environment. Optional bucket, endpoint, and public-base variables are documented in the synchronization workflow.
- npm [Trusted Publisher](https://docs.npmjs.com/trusted-publishers): bind `QwenLM/Qwen-Live-Harness`, workflow `qwen-live-harness-host-release.yml`, and environment `production-release`. The publishing job uses OIDC with `id-token: write`, not `NPM_TOKEN`; public-repository publications include provenance. The workflow pins Node/npm versions that support Trusted Publishing.

## License

[Apache License 2.0](../../LICENSE).
