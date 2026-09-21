# Qwen Live Harness · Daemon Development Guide

[简体中文](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/README_ZH.md) | English

This directory contains the `qwen-live-harness` npm package. The daemon manages model connections, conversation scheduling, task delegation, Proactive, and Memory. The separate macOS Host handles the desktop UI, system permissions, and device capture.

[Project overview and installation](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/README.md) · [Configuration and features](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/docs/configuration.md) · [Host development guide](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md)

[Run from source](#run-from-source) · [Code map](#code-map) · [Backend integration](#integrate-a-background-harness) · [Qwen terminals](#qwen-terminal-integration) · [Protocols](#protocols-and-capability-boundaries) · [Advanced configuration](#advanced-configuration)

## Run from source

Use Node.js **22.13+**. Full desktop interaction currently requires macOS. Run all commands below from the **repository root**:

```bash
npm ci
npm ci --prefix packages/qwen-live-harness-host
npm run init
npm start
```

`npm run init` builds the daemon, opens the source initialization wizard, and saves configuration. It does not download or install Host, or change the runtime registration used by an installed desktop application. You can select a coding agent or continue without a background Harness.

For Qwen Code, the default is a local Qwen Serve instance managed by Live. You can instead connect to an existing local service or select ACP. Initialization only saves the settings; a managed service starts with the daemon. See [Qwen terminal integration](#qwen-terminal-integration) for the difference between discovering a terminal and authorizing access to it.

`npm start` builds both packages and starts this checkout's daemon and Electron Host. It does not use the global CLI or Host in `/Applications`. Quit existing Qwen Live Harness instances first; the source launcher refuses to take over a running instance. `Ctrl+C` cleans up the processes started by this launcher.

For diagnostics:

```bash
npm start -- --debug
```

[`scripts/start-dev.mjs`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/scripts/start-dev.mjs) implements the source entry point. Installed npm users follow the different startup flow in the [main README](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/README.md#quick-start).

## Code map

- [CLI/configuration](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src): `index.ts`, `cli-startup.ts`, `config.ts`, `init.ts`; `peer-setup.ts` and `peer-diagnostics.ts` handle terminal setup.
- [Daemon](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/daemon.ts) / [Host protocol](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/host): service assembly, discovery, transport and cleanup.
- [Orchestrator](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/orchestrator) / [Realtime](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/realtime): call lifecycle, prompts, model workers, response and result scheduling.
- [Adapters](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/adaptor): backend capabilities, ACP, Qwen Serve and peer protocol.
- [Tools](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/tools) / [permissions](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/permissions) / [subagents](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/subagents): schemas, handles, approvals and task management.
- [Proactive](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/proactive) / [Memory](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/memory) / [logs](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/log): monitoring, storage/retrieval and diagnostics.
- [messages.ts](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/i18n/messages.ts): paired English/Chinese CLI and Host labels.

The main path is `LiveDaemon → LiveHostCoordinator → LiveSession → Realtime / BackendAdaptor`. Qwen Serve is an optional REST/SSE backend, not a prerequisite for ACP or no-backend mode.

## Build and test

Run from the repository root:

```bash
npm run build
npm run typecheck
npm test
npm run lint:all
npm run format:check
npm run check:boundaries
npm run check:package
```

`npm test` runs daemon, script and integration tests, **not Host tests**. `npm run lint` covers daemon/integration/scripts; `lint:host` covers Host and `lint:all` runs both. For Host or shared changes, also run `npm run typecheck:host`, `npm run test:host` and `npm run build:host`; see the [Host guide](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md).

Run one daemon test with:

```bash
npm test --workspace qwen-live-harness -- src/orchestrator/live-session.test.ts
```

Default tests use fakes and local services, not model accounts or devices. `check:package` creates and installs the actual npm tarball in a temporary directory and can access npm. Real backend/provider/device checks are separate; do not use personal credentials, sessions or permissions in automated fixtures.

## Isolated configuration and daemon-only debugging

The default configuration file is `~/.qwen-live-harness/config.json`. Its parent data directory also stores Memory and session data.

Use a separate directory for development configuration, memories, session logs, and discovery. Set these variables in the terminal used for both initialization and startup:

```bash
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-dev"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
npm run init
npm start -- --debug
```

These variables set the data directory and discovery **base directory** separately. Changing only `DATA_DIR` does not move discovery; isolate both when using separate development configurations. See [Environment variables](#environment-variables) for precedence.

To run only the daemon, build it and invoke its output directly:

```bash
npm run build
node packages/qwen-live-harness/dist/index.js --daemon-only --debug
```

`npm start` is a two-process development launcher and does not accept `--daemon-only`. To start Host separately, use its development entry point and set `QWEN_LIVE_HARNESS_DISCOVERY_FILE` to the complete corresponding `run/daemon.json` path, not just its base directory.

Process contracts:

- `run/daemon.json` publishes a loopback address, protocol version, PID, and instance nonce. Connections validate a Bearer token and nonce. This file is private state; do not print or copy its credentials.
- `run/runtime.json` supports desktop startup for **installed releases**. It records absolute Node/CLI paths, versions, and necessary startup information, not API keys. Source `npm start/init` does not create or refresh it.
- Normal shutdown writes an instance-specific stop marker so Host can exit even during a handshake or reconnection. Match the marker to its instance; a stale marker must not close a new one. An ordinary disconnection is not a quit request.
- End call stops the current interaction and Proactive capture; delegated backend jobs may continue. Full application shutdown cleans up daemon-owned resources, ACP children, and managed Qwen Serve, not independently running user services or terminals. Shutdown retries remain bound to the original authenticated instance.

See [`startup.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/startup.ts), [`startup-lock.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/startup-lock.ts), [`host/discovery.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/host/discovery.ts), and [`lifecycle.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/lifecycle.ts).

## Integrate a background Harness

For an ACP-compatible agent, configuring `kind: "acp"`, `command`, `args`, and any required `env` is usually enough. To include it in initialization discovery, extend [`agent-detector.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/agent-detector.ts) and its tests.

For a new protocol, implement [`BackendAdaptor`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/types.ts):

1. Add an adapter under `src/adaptor/` implementing preflight, session management, `prompt`, events, cancellation, permission responses, and `close`.
2. If needed, extend `BackendConfig`, validation, and `buildAdaptor` in [`daemon.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/daemon.ts). Keep backend-specific branching out of the call scheduler.
3. Describe the adapter's supported behavior in `capabilities()`, add protocol tests, and verify delegation, event correlation, permissions, and cleanup.

Use [`AcpAdaptor`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/acp-adaptor.ts) and [`QwenCodeAdaptor`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-code-adaptor.ts) as references. The latter connects to Qwen Serve over REST/SSE. [`ManagedQwenServe`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/managed-qwen-serve.ts) handles managed startup; an existing external service remains user-owned.

Preserve these contracts:

- `prompt()` returns an acceptance or queueing receipt, not a final result. Confirm completion through events such as `turn_complete`, correlated by a stable `jobRef` or explicit joined-turn identifiers.
- Declare supported capabilities in `steering`, `imageInput`, and `permissionForwarding`. Report unsupported image input rather than claiming an image was delivered. Continuous backend observation currently requires `eventDelivery: "stream"`; other delivery modes need a corresponding consumer implementation.
- Forward permission requests issued by the backend. An ordinary write failure is not a permission request and should not trigger a fabricated approval dialog or automatic approval. Cancelling an unknown job must not stop unrelated work in the same session.
- `close()` cleans up processes, subscriptions, and requests owned by the adapter, not independent user services.

`backends: []` explicitly selects no-backend mode without creating a placeholder agent. Conversation, visual input, Proactive, and Memory remain available; backend tools return `no_backend`. An unavailable configured default backend still fails startup rather than silently enabling no-backend mode.

## Qwen terminal integration

This integration connects existing **interactive Qwen Code terminal sessions** through Qwen's public peer protocol. It neither reads arbitrary terminal stdout nor manages external terminal processes. Discovery, text delivery, and report reception are configured separately.

### Three Qwen Code connection modes

The main wizard offers:

| Mode                                  | Configuration and lifecycle                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Managed local Qwen Serve, the default | `kind: "qwen-code"` with `managedServe.command`; starts installed Qwen on loopback with an assigned port and fresh token, and cleans up that service on exit |
| Existing local Qwen Serve             | `kind: "qwen-code"` with `baseUrl` and optional `token`; does not start or stop the external service                                                         |
| ACP                                   | `kind: "acp"`, launched as `qwen --acp`; no peer terminal discovery                                                                                          |

Example managed entry:

```json
{
  "name": "qwen",
  "kind": "qwen-code",
  "default": true,
  "managedServe": { "command": "/absolute/path/to/qwen" }
}
```

Add this entry to `backends` and replace `command` with the executable's path. `managedServe` cannot be combined with `baseUrl`, `serveUrl`, or `token`; the working directory comes from `defaultCwd`. Qwen uses its own model authentication and settings. Live does not change those settings or grant permission to send terminal messages.

Choosing either Serve mode also saves read-only `peerDiscovery` for the current `QWEN_HOME`, defaulting to `~/.qwen`. It neither grants text-delivery permission nor enables reports. For a manually configured remote Serve, the local peer directory still discovers local terminals, not remote terminals.

<a id="terminal-setup-and-diagnostics-m3-stage-4"></a>

### Incremental setup and read-only diagnostics

With an existing Live configuration, run from the repository root:

```bash
npm run build
node packages/qwen-live-harness/dist/index.js init --peers
node packages/qwen-live-harness/dist/index.js doctor --peers
```

Installed equivalents are `qwen-live-harness init --peers` and `qwen-live-harness doctor --peers`. The source launcher does not forward `--peers`, so use the built entry point above.

`init --peers` edits only the selected `qwen-code` backend's `peerDiscovery`. You can select an existing backend or add one connected to an existing Serve; it does not convert ACP to Serve. Other settings and the default backend stay unchanged, and cancelling writes nothing. A `config.json` must already exist. The command refuses edits if backend environment overrides would prevent them from taking effect. Saving uses a lock and atomic replacement, so avoid editing the file elsewhere at the same time. Restart Live afterward.

`doctor --peers` checks configuration, terminal directories, connection capabilities, and authorization settings without starting a call, sending commands, or granting access. A managed Serve that has not started is shown as unverified; diagnostics do not start it or assume a dynamic port. A controller can be configured even if its grant is no longer valid.

### Discover existing terminals

Discovery requires a `kind: "qwen-code"` backend with `peerDiscovery.qwenHome` matching the target terminal's local Qwen home. Qwen must have `agents.crossSessionMessaging: true`; restart the target terminal after changing it. Omitting `peerDiscovery` disables discovery. ACP entries do not support it.

During a call, `session_list` includes managed sessions and reachable `tui` terminals. Host's **Terminal sessions** section refreshes this list. External execution state remains `unknown`; without a controller grant, terminals are read-only. They are not counted as ordinary Running / Completed tasks.

Directory and socket names are display metadata. Delivery uses a handle bound to Qwen home, session ID, PID, and start time, rather than selecting a terminal by name alone. A discovery failure provides no information about whether a terminal's task has completed.

### Send text to a terminal

Using a Qwen CLI that supports `sessions controllers`, manually create a controller grant in the **same Qwen home**:

```bash
QWEN_HOME="$HOME/.qwen" qwen sessions controllers add --label "Qwen Live Harness" --json
```

Save the returned token through incremental setup, or set `peerDiscovery.controllerTokenEnv` to the name of an environment variable containing it. Use either `controllerToken` or `controllerTokenEnv`, not both. This is a separate credential from the Serve REST token; do not pass it by voice. The process launching Live must be able to read the variable. Double-clicking Host does not automatically inherit terminal variables.

Start a call, list sessions, and ask Live to send a specific instruction to the selected terminal. `handoff` sends the text and returns a separate `delivery_N` receipt. The receipt tracks delivery, not a backend job: it does not confirm execution, steering of an active turn, or completion. This channel does not support screenshot attachments, stopping terminal jobs, or responding to their tool permission requests.

The target's `agents.crossSessionInbound` policy still applies: `hold` requires terminal review; `refuse` rejects delivery. Host shows **Instruction deliveries**, and `session_monitor` accepts a `delivery` argument:

- `pending`: write attempted, no receipt yet; `held`: waiting for terminal review.
- `delivered`: entered the inbox, not task completion; it may later become `expired` or `misaddressed`.
- `denied`, `refused`, and `dropped` reflect actual receipts. `unknown` means uncertainty, not permission to resend automatically.

Without a receipt, delivery becomes unknown after 30 seconds by default. Each controller retains at most 100 deliveries, evicting finished tracking entries first and rejecting new sends if all entries are still tracked. End call stops tracking but cannot retract an instruction already written. Qwen owns grant management, revocation, and terminal review.

Before sending, Live rechecks registration and fixes the target socket and full session ID for that delivery. The protocol has no atomic PID/start-time check, so directory metadata cannot strongly authenticate a terminal against other programs running as the same user.

### Receive and speak reports

`peerDiscovery.reports: true` separately enables reports; the default is `false`. Receiving reports neither requires a controller grant nor makes terminals controllable. Each call publishes a temporary Live peer address; handoff includes the address and a reporting example when applicable.

The target session must provide the public `send_message` tool, share the Qwen home, and permit that tool call. Live does not grant this permission. Managed sessions can also use the public tool. An adapter without its own report endpoint gets reporting instructions only when exactly one report provider is available.

Reports can be `progress`, `blocked`, `result`, or `info`; plain text is received as `info`. **Session reports** in Host shows the source, body, and queued/submitted/spoken status. Query reports with `session_monitor` and `reports: true`. Ambiguous sources are marked unconfirmed. Source matching identifies the reported origin but does not strongly authenticate arbitrary programs running as the same user.

Report announcements wait for user speech, foreground responses, and device playback to finish, then use a separate, disposable speech-only connection with no tools or search. A report is not a new user instruction, permission answer, or verified completion event. Results for associated managed jobs are still announced through the original backend events, avoiding duplicate completion reports. Muting output preserves the text; interrupted or failed announcements are not automatically replayed.

Each report is limited to 2,000 characters. Reception limits are 20 per minute overall and 6 per source socket; attribution and speech queues hold 32 each; display history holds 100. Addresses and associations expire at call end, and old messages are not replayed. Previous-call reports remain visible until the next call starts.

Implementation: [`qwen-peer-discovery.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-discovery.ts), [`qwen-peer-controller.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-controller.ts), [`qwen-peer-reports.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-reports.ts), and [`session-reports.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/orchestrator/session-reports.ts). The peer SDK includes a pinned copy of the [official Node-only source](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/vendor/qwen-code-peer/README.md), with provenance checks. Peer transport supports macOS/Linux; full desktop interaction still requires macOS. Terminal protocol tests use Qwen Code 0.23.3; older versions may not support these capabilities. See the checks below for integration verification.

### Terminal integration checks

Use isolated Live/Qwen homes and a test controller grant. Protocol tests can run against a real Qwen CLI with local fake model, Realtime and Host providers:

```bash
TEST_CLI_PATH=/absolute/path/to/qwen/cli.js npm run test:backends -- qwen-live-harness-m3-discovery qwen-peer-instructions qwen-peer-reports
```

For manual acceptance with matching Host and daemon builds:

1. Run `init --peers` and `doctor --peers`; verify existing backends/defaults are preserved and grant/report settings are independent.
2. Discover two test Qwen terminals and address the intended one. Exercise delivered, held, denied/refused and unknown receipts; delivery does not prove execution.
3. Send reports. Verify source attribution, FIFO speech, mute/interruption, and normal managed/ACP tasks and approvals alongside them.
4. End the call while terminals continue working. Confirm old addresses and queued speech expire; start another call, then disable discovery and verify other backends still work.
5. Revoke only the test grant and stop test-owned processes. Record commit, Qwen/Node versions, build, commands and observed results.

Protocol tests, installation, UI, physical audio and production-model behavior are separate evidence. A green test or successful connection is not full voice acceptance.

## Protocols and capability boundaries

### Model tools and MCP

Main Omni identifies as **Qwen Omni** and receives daemon-defined tools, not every backend tool. It answers ordinary conversation directly, prefers `web_search` for public-information lookups, and delegates file operations, commands, complex work or explicitly assigned coding tasks. MCP belongs to the configured background Harness; ACP currently creates/loads sessions with `mcpServers: []`. New MCP support needs an execution and permission channel, not only prompt changes.

`web_search` returns `accepted + taskId` and runs a text-only connection using the exact main model ID, endpoint and key, without a model-name allowlist or separate setting. Queries can run concurrently with a 25-second timeout; they exclude microphone audio, screenshots, Memory and other task context. Provider metadata distinguishes a confirmed search from unknown status.

If search fails and a backend is configured, the runtime creates one isolated read-only query on the default backend using the original query and normal permissions; without a backend, it reports failure. Failed output or webpage text cannot authorize work or duplicate fallback. End call cancels searches and their automatic fallback tasks, not unrelated jobs. Cancellation is a request until confirmed by the backend.

**Result delivery.** Visual, search, task-result, peer-report and automatic-permission notifications share a FIFO gated by user speech, foreground responses, receipt processing and Host playback. A separate speech-only connection uses the same model/voice, a purpose-specific policy and quoted data bounded to 16,000 characters, with no tools or search. It waits for the matching user-item acknowledgement before `response.create`; generation and audio are each bounded to 30 seconds. Only successful responses passing PCM/tool-syntax checks are played. Failed/unknown outcomes cannot become success. Main Omni receives silent `[RESULT_AVAILABLE]` evidence and `[RESULT_DELIVERY]` after playback confirmation. Interruptions cancel delivery without replay; text stays available. Proactive's distinct fallback is described [below](#proactive-announcement-fallback).

**Instructions and authority.** Main system instructions stay fixed for the call, sent once per connection in `session.update`, never repeated in `response.create`. Runtime results use typed, quoted `conversation.item.create` data, not new user authority. Memory uses replaceable `[MEMORY_CONTEXT]` snapshots (empty when disabled); reconnect restores the latest snapshot. Tool changes use a tools-only session update, without deleting previous conversation history.

**Task lifecycle.** Creation, updates and cancellation require a clear current user request, not chitchat, criticism, quoted speech, old tasks or the assistant's own promises. The runtime binds the operation to the final transcript of its input item, rechecks it after waiting for ASR, and rejects stale/replaced inputs and ambiguous or mismatched control targets. The additional English/Chinese intent filter is deliberately conservative: unclear wording requires clarification, not guessed action. Stopping speech does not stop background work, and broad cancellation needs explicit all-task scope. The same input cannot repeat an identical task mutation; a new explicit request may create the task again. Missing-tool repair is limited to an unhandled, verified user request and its allowed operation/targets; it cannot turn a conversational correction into a monitor or a creation promise into cancellation. UI stop controls remain explicit user actions. Rejections are recorded as `task.authorization_rejected` and leave the conversation open.

**Tool receipts.** Execute only after completed `response.done` confirms final call IDs, names, arguments and status. After the service acknowledges an accepted asynchronous receipt, drain a separate `tool_continuation` before announcing its result. A matching Unknown call ID or 10-second result-ACK timeout ends that continuation without re-executing the action; other errors retain their own handling. Repeated identical accepted work in that receipt continuation reuses its original receipt, not a new task; new user requests are unaffected.

Duplicate confirmation audio is suppressed only if there was already an audio preamble and **all tools in the parent response** successfully accepted eligible async work: `web_search`, Appshot analysis, warning-free managed `handoff`, or `create_proactive_monitor` / `create_live_narration`. Errors, warnings, mixed queries, permission replies, terminal deliveries, `session_create`, timers and task updates/cancellation remain audible. Suppressed text stays in provider/debug history (`audioSuppressed:true`), not user-heard Memory, handoff or reconnect history. A receipt overtaken by a new user turn drains silently without old tool authority; new answers and final results are not muted.

### Audio and visual input

Main Realtime uses `semantic_vad`, `create_response:false`, `interrupt_response:true`: the service detects turns and the daemon schedules responses. Memory/tool continuations do not change VAD. Independent manual-input workers use `turn_detection:null`.

Transport is mono PCM16: **16 kHz input / 24 kHz output** (`session.audio.output.format.sample_rate:24000`). Host resamples to the device's actual rate without forcing its hardware clock. `session.start.outputSampleRate` records the decoded rate.

| Path                   | Evidence destination                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| Live Feed              | Selected camera or full selected display → main Omni                            |
| On Demand Appshot      | Snapshot → independent Visual Analysis; text evidence/asset receipt → main Omni |
| Proactive              | Selected-source frames/audio → independent Monitor, also sampled in On Demand   |
| Optional visual Memory | Live frames or separate On Demand capture → text observations                   |

Appshot returns `accepted + taskId` and an asset handle, not an image answer. The `kind:"visual"` worker uses the main model/endpoint/key without tools/search; no backend is required. Optional `query` identifies the question, otherwise use the current turn's final transcript or a general description. The main conversation receives text evidence, not snapshot pixels; an asset handle alone is not visual evidence.

Each attempt sends two one-second protocol-silence segments, each followed by the same JPEG, commits once, waits for acknowledgement, then asks the visual question through `response.instructions`. The fixed system prompt is sent once; no private Memory/unrelated dialogue is included. Duplicate frames satisfy the API format, not motion evidence. A repeat-output service error, supported transient network failure or timeout allows **one retry**, using the same image/question on a fresh connection with a shorter answer format. Discard failed partial output. Each attempt is 25s, at most 50s total; cancellation stops it immediately. Auth/config/input/unsafe-output errors are not retried. Never recapture or delegate to a coding agent as a retry.

Parallel analyses use the [shared result-delivery path](#model-tools-and-mcp). Screenshot text is untrusted evidence; missing metadata does not prove a blank desktop. Retain uncertainty and do not repeat accepted actions. Screen assets preserve original PNGs; model input follows transport limits. `visual.analysis` / `visual.delivery` correlate analysis and speech without logging image bytes.

Host protocol **v9** is defined in [host/types.ts](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/host/types.ts), [realtime-session.ts](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/realtime/realtime-session.ts) and Host's shared protocol:

- Preserve call epoch and output ID through audio start, end markers, playback completion and clearing. Stale acknowledgements must not advance new output.
- Negotiate display capture/end-marker capabilities. Playback completes only after the output's marker and all queued audio drain.
- Proactive events queue FIFO while capture continues; updates/cancellation withdraw old task generations.
- Full-display capture does not guarantee native resolution. Enforce frame/asset limits and discard captures from old source/display/epoch selections.

### Logs and shared text

Basic failure files do not require `--debug`; that flag adds detailed protocol/media diagnostics. `<dataDir>` defaults to `~/.qwen-live-harness`.

| Evidence                  | Location / use                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Session events            | `<dataDir>/sessions/live-*.jsonl`; tools, responses and runtime events; normally 32 MiB per rotated file                                     |
| Runtime failures          | `<dataDir>/logs/runtime-errors-*.jsonl`; one file per process, rotating at 1 MiB with one backup                                             |
| Host faults and geometry  | See [Host diagnostics](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md#logs-and-shared-text) |
| Debug run / Monitor media | [Run archives](#run-archives-and-offline-inspection) and [Monitor archives](#monitor-diagnostic-archives), with independent retention        |

Correlate `callId`, `epoch`, `providerSessionId`, `responseId`, `toolCallId` and task/output IDs. `failure` records contain source, code, stage, impact and bounded diagnostics. `executionUncertain` warns that work may already have happened; `transient` does not authorize retry and `fatal:false` does not mean success.

| Failure boundary                           | Current handling                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool/receipt error or timeout              | Preserve actual task state. Missing receipts do not prove no side effect; never automatically replay writes, commands or approvals.                                                                                                             |
| Response acknowledgement/cancellation loss | At most two main transport replacements per call; restore only trustworthy input with no dispatched tool. No tool replay or transferring an old approval to a new request. Ordinary network/auth failures are not a universal reconnect policy. |
| Search / visual / Monitor                  | Isolated task failure; search can use its fallback, visual analysis can retry once, Monitor stops at its consecutive-failure limit. Generation and playback remain separate.                                                                    |
| Memory                                     | Embedding may fall back to lexical search. An update/observation failure does not imply an empty library or justify deleting it.                                                                                                                |
| Media / logs                               | Input loss can end the call; muted/interrupted output is not heard. Logs can be incomplete after storage faults, native crashes or forced termination.                                                                                          |

A semantic-VAD input item is not a commit: only `input_audio_buffer.committed` schedules its response. While the microphone is muted, a 1s PCM-silence heartbeat every 30s keeps the main connection active without commit/response creation; it is not Monitor input or genuine speech. It cannot prevent all provider/network failures.

Search delivery uses `search.delivery` / `web_search.delivery`; transcripts use `source: "isolated_result"`. `audio_started` means forwarded to Host, not heard; matching playback completion confirms delivery. `result_speech.unspoken` records interrupted/rejected announcements.

See [runtime failure definitions](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/log/runtime-failure.ts), [Realtime handling](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/realtime/realtime-session.ts) and their tests for individual codes. Fixed UI/init text lives in [messages.ts](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/i18n/messages.ts), with matching English/Chinese placeholders; prompts and raw backend output are not UI translations.

## Advanced configuration

This section covers settings for adapter, scheduler, and memory development. User-facing editing steps and common examples are in [Configuration and features](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/docs/configuration.md). For complete validation rules, see [`config.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/config.ts) and [`memory/config.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/memory/config.ts). Omitted values use their defaults; configuration files do not need to list them all.

### Backend startup and compatibility

Initialization detection is implemented in [`agent-detector.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/agent-detector.ts). Current entry points:

| Backend     | Entry point                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Qwen Code   | Managed local Qwen Serve by default; existing Serve or `qwen --acp` are alternatives                 |
| Qoder CLI   | `qodercli --acp`                                                                                     |
| Gemini CLI  | `gemini --experimental-acp`                                                                          |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp`                                                       |
| Codex       | `npx -y @agentclientprotocol/codex-acp`; initialization sets `CODEX_PATH` to the detected executable |
| Qwen Serve  | REST/SSE with `kind: "qwen-code"`; managed startup or an existing service URL                        |

ACP separates `command`, string-array `args`, string-valued `env`, and optional `cwd`; it does not concatenate a shell command. Desktop startup prefers absolute paths generated during initialization. An `npx` adapter may install dependencies on first use.

Backend names are 1–32 letters, digits, underscores, or hyphens, starting with a letter or digit. Uniqueness is case-insensitive, but references should use the configured spelling. Multiple backends require exactly one `default: true`. Default-backend preflight failure blocks startup; unavailable secondary backends are marked unavailable.

Example configuration for an existing REST/SSE service:

```json
{
  "backends": [
    {
      "name": "qwen-server",
      "kind": "qwen-code",
      "serveUrl": "http://127.0.0.1:4170",
      "default": true
    }
  ]
}
```

Set `token` if authentication is required. `baseUrl` is an alternative to `serveUrl`. These entries do not use ACP process fields. Omitting `backends` selects the default local `qwen serve` connection; use `[]` to disable backends explicitly.

### ACP permission modes

An ACP backend's optional `sessionMode` must **exactly match** an `id` in the backend's `session/new` `availableModes`. This is backend-defined, not a universal “skip approval” switch, and does not apply to `kind: "qwen-code"` Serve entries.

If the field is omitted or the ID is not found, Live looks for an approval-requesting mode exposed by the backend: first `default`, then a `read-only` mode named `Ask for approval`. A missing requested ID produces a warning. If neither mode is available, or `setSessionMode` fails, the backend keeps its own mode. This fallback therefore **does not guarantee per-operation manual approval**.

The backend determines the mode's actual permission scope; check its documentation and selected state. The current success log describes any explicit `sessionMode` as not requiring per-operation approval, so that message alone is not a reliable description of permissions. Selecting `default` does not imply unrestricted access. Test valid and invalid IDs, missing modes, switch failures, and permission forwarding.

<a id="spoken-permissions-and-persistent-approval"></a>

### Spoken permissions and global approval mode

`permissionMode` is global: `"ask"` (default) asks for each request; `"allow-all"` automatically approves waiting and future requests after a successful save. Set it in init after backend setup, Settings or configuration. Switching to ask stops unissued automatic votes, not approvals already sent. Backend restrictions still apply.

In ask mode, main Omni asks in the real conversation's language, using `config.language` only as fallback. Backend titles/commands/paths are approval data, not language instructions or consent. The question has no tool authority; only a later explicit answer bound to the pending permission ID can invoke `respond_permission`. Subagents offers equivalent Allow/Deny controls and structured details.

Both modes select the narrowest identifiable **one-time** backend approval; no persistent grant is created. Without a one-time option, cancel with an explanation. Missing details are not invented. Manual/automatic votes share an in-flight fence per session/request, rechecking the mode before each automatic vote; failed delivery remains visible. Other pending approvals must not be mistaken for a running job.

Automatic approvals work without a call and do not start audio. During calls, writes, execution, network and unclassified operations get an isolated `permission_execution` notice; simple `pwd`, `ls`, `git status` checks are recorded silently. Classification controls speech, not approval. The helper reads one fixed, locally named sentence without arguments or paths; altered wording/execution claims discard its audio. `approval_delivered` means approved, not executed.

Legacy `allow_always` applies once; `permission-policies.json` is ignored and left untouched. Existing backend-native grants must be revoked there. Notifications follow the [shared delivery contract](#model-tools-and-mcp); real-user language samples can select language across calls but are never result facts.

### Proactive tuning

The scheduler sends **two-second media chunks, with visual input fixed at 1 FPS**, to an independent Monitor. Capture, inference, and foreground delivery are separate stages. More frequent scheduler checks do not make an incomplete chunk ready or eliminate network, model, or playback delays.

`create_proactive_monitor` creates a condition-based observer, `create_proactive_timer` creates a time-based reminder, and `create_live_narration` creates ongoing descriptions of meaningful changes. Narration creation accepts exactly three fields: `title`, `modalities`, and `narration_focus`. Runtime binds the task to its original real-user request and carries its applicable language, tone, and detail preferences through Monitor judgments and speech delivery. Preferences from unrelated tasks do not expand its scope, and requested content is not treated as observed evidence. Explicit changes to `narration_style` through the task-update tool override conflicting style preferences for that task. Cancellation and updates invalidate queued events from the prior task generation.

| Field under `proactive`                | Default    | Meaning                                                                                                               |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`                              | `true`     | Enable monitoring and tools                                                                                           |
| `monitor.sessionRecycleEvals`          | `60`       | Rebuild a Monitor connection after this many evaluations                                                              |
| `monitor.representationCompact`        | `"normal"` | Visual representation aggregation: `normal` or `none`; unused for audio-only monitors                                 |
| `scheduler.evalIntervalSec`            | `1`        | Seconds between checks for the next evaluation                                                                        |
| `scheduler.maxFailuresPerTask`         | `3`        | Consecutive failures before stopping a task                                                                           |
| `scheduler.repeat.cooldownSec`         | `3`        | Repeat-trigger cooldown, seconds                                                                                      |
| `scheduler.repeat.maxWaitTtsSec`       | `30`       | Preparation-to-playback-ack deadline per attempt, including fallback generation/playback; excludes earlier queue time |
| `scheduler.repeat.clearBufferOnResume` | `true`     | Clear old pending capture on resume                                                                                   |
| `vision.windowSizeSec`                 | `10`       | Local new-frame buffer limit, seconds; not history resent every round                                                 |
| `vision.minEvalDurationSec`            | `0`        | Extra observation before the first evaluation; zero still requires a full chunk and at least two valid new frames     |
| `audio.windowSizeSec`                  | `60`       | Local new-audio buffer limit, seconds                                                                                 |
| `audio.minEvalDurationSec`             | `0`        | Audio observation before the first evaluation                                                                         |

Both buffer windows must be at least two seconds, and minimum observation duration cannot exceed the corresponding window. Monitor FPS and chunk duration are protocol constants, not configurable fields. Foreground Live Feed has a separate `visualInput.fps` setting. A long capture gap resets continuous observation duration. Incomplete chunks are skipped, and previously evaluated frames do not count as new evidence.

All Monitor modalities use an interleaved streaming-buffer session. One initial `session.update` per connection sets the fixed system instructions, `turn_detection: null`, `smooth_output: false`, and empty tools. Each round appends new audio and, for visual monitors, new images; it then sends `input_audio_buffer.commit` and waits for `input_audio_buffer.committed` before requesting inference. The next chunk is submitted only after `response.done`. The service retains earlier user media and assistant replies; the client does not reconstruct or resend that history.

Only the first media request on a Monitor connection includes the task text, using `{"type":"response.create","response":{"instructions":"TASK_TEXT"}}`. Here `response.instructions` carries the task text for that first user media turn, not the Monitor's system prompt. Later chunks use bare `response.create` without the field; no separate task-only `conversation.item.create` is sent. A rebuilt connection includes the task with its first new media chunk again, without replaying old media. Independent On Demand Visual Analysis uses the same field for its one image question. These are manual-media request paths; foreground conversation, tool continuations, runtime result notifications, and Web Search continue without response-scoped instructions.

Every audio-only chunk contains two seconds of mono PCM16 at 16 kHz, without extra silence. A video-only chunk appends one second of `protocol_silence`, one fresh image, another second of silence, and a second fresh image, then commits once; it contains no microphone audio. An audio/video chunk uses the same order with real one-second microphone segments and their corresponding images. Each visual round therefore contains exactly two fresh frames from the same two-second span. Missing images are not replaced with previously captured ones; incomplete chunks log their drop reason.

While inference is running, new media waits in bounded local queues. It is not added to the server's active input buffer, and accumulated chunks are not merged into one longer evaluation. Rebuilding a connection loses its model history. Only new media that has not yet been submitted is retained; previously evaluated sounds or images are not replayed. Use `transportGeneration` to distinguish connection histories.

`monitor.representationCompact` maps to `session.video.input.representation_compact` in the initial session update, before any audio, including protocol silence. It does not change within a connection and remains configured after recycle/recovery. Restart after editing; `none` is useful for fine visual detail.

There is no configured Monitor-count limit. Resource use, sampling, model latency, and notification queues still constrain practical concurrency.

#### Proactive announcement fallback

A completed foreground Proactive response with **zero audio**, including `remain_silent`, permits one independent speech attempt for the same delivery—not another trigger or media evaluation. Failed/cancelled primary responses are ineligible. Drain any `remain_silent` receipt first, then wait through the usual FIFO/foreground/playback gates.

The helper uses the main model, endpoint, key and voice, 24 kHz PCM, `smooth_output:false`, `turn_detection:null`, no tools/search or response-scoped instructions. It receives a fixed policy, quoted observation summary and conversation language, not raw media, Memory or trigger/intervention instructions. This is delivery, not independent verification.

Buffer the complete successful audio before playback. Generation and PCM are bounded to 20s (960,000 bytes); `maxWaitTtsSec` still bounds preparation through playback acknowledgement and is not extended. Failure marks delivery `undelivered` without failing a repeating monitor.

| Delivery state         | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `queued` / `preparing` | Waiting / generating, not yet heard                         |
| `speaking`             | Host acknowledged playback start                            |
| `delivered`            | Generation succeeded and Host confirmed playback completion |
| `undelivered`          | Not fully played; never describe it as heard                |

Speech, mute, cancellation and End call invalidate fallback delivery. Recovery may preserve an attempt that has not started; after generation/playback starts, interruption aborts it without replay. A one-shot task can be completed while delivery is undelivered. On the primary path, muted events can be consumed without replay on unmute: consumed/completed is not proof of hearing. Debug `proactive.fallback_*` and `proactive.delivery_undelivered` events correlate task/delivery IDs.

### Memory model connections

The updater consolidates long- and short-term information from conversations. A separate, optional observer creates environment memories from visual input. These are independent paths: the updater does not produce environment-observation records, and disabling it does not delete those memories or disable observer capture and environment retrieval.

Updater and observer use same-region `/compatible-mode/v1/chat/completions` derived from the Realtime endpoint by default; vector retrieval uses `/compatible-mode/v1/embeddings`. The updater defaults to `qwen3.7-plus`; an omitted `observer.model` inherits it. Visual observation requires image support.

`updater.baseUrl` / `observer.baseUrl` override the respective HTTP(S) compatible API base URL, without a `/chat/completions` suffix. `apiKeyEnv` names a credential environment variable and requires its corresponding `baseUrl`. A custom base URL with an empty `apiKeyEnv` still receives the main API key; confirm that you intend to send that credential to the service. Embeddings always use the main DashScope connection.

### Memory tuning

All fields below are under `memory`. Omitted values use these defaults. Users typically need only the toggle, model, directory, and observation interval. Context-entry and character limits do not delete local history or limit the entire database.

<details>
<summary>Memory parameter reference</summary>

| Field                                     | Default                 | Purpose                                                |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `enabled`                                 | `true`                  | Master Memory toggle                                   |
| `dir`                                     | `""`                    | Empty uses `<dataDir>/memories`                        |
| `defaultId`                               | `"default"`             | Selected library ID                                    |
| `updater.enabled`                         | `true`                  | Long-/short-term consolidation after calls             |
| `updater.model`                           | `"qwen3.7-plus"`        | Updater model                                          |
| `updater.baseUrl` / `updater.apiKeyEnv`   | `""` / `""`             | Optional connection overrides                          |
| `updater.timeoutMs`                       | `120000`                | Request timeout, milliseconds                          |
| `updater.temperature`                     | `0`                     | Generation temperature                                 |
| `updater.maxTokens`                       | `2048`                  | Output token limit                                     |
| `updater.maxWmEntries`                    | `64`                    | Working-memory entries per update                      |
| `updater.shutdownWaitSec`                 | `2`                     | Shutdown wait for consolidation, seconds               |
| `observer.enabled`                        | `false`                 | Visual memory toggle                                   |
| `observer.model`                          | Inherit `updater.model` | Image-capable observer model                           |
| `observer.baseUrl` / `observer.apiKeyEnv` | `""` / `""`             | Optional observer connection overrides                 |
| `observer.intervalSec`                    | `60`                    | Observation interval, seconds                          |
| `observer.timeoutMs`                      | `60000`                 | Request timeout, milliseconds                          |
| `observer.temperature`                    | `0`                     | Generation temperature                                 |
| `observer.maxTokens`                      | `400`                   | Output token limit                                     |
| `observer.maxContentChars`                | `400`                   | Stored description character limit                     |
| `observer.maxFrameAgeSec`                 | `15`                    | Maximum accepted frame age, seconds                    |
| `wm.maxEntries` / `wm.maxEntryChars`      | `128` / `200`           | Working-memory entry count / per-entry character limit |
| `segment.maxTurns`                        | `4`                     | Maximum turns per conversation segment                 |
| `segment.minTurnsBeforeGapCut`            | `2`                     | Minimum turns before splitting on silence              |
| `segment.maxChars`                        | `1000`                  | Segment character threshold                            |
| `segment.silenceGapSec`                   | `60`                    | Silence gap for splitting, seconds                     |

Retrieval:

| Field                                     | Default               | Purpose                                                                                          |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `retrieve.topK`                           | `3`                   | Maximum results                                                                                  |
| `retrieve.maxChars`                       | `5000`                | Character limit for raw result text                                                              |
| `retrieve.retrievedMaxChars`              | `6000`                | Character limit for the retrieved section rendered into context                                  |
| `retrieve.useVector`                      | `true`                | Hybrid vector/keyword retrieval                                                                  |
| `retrieve.model`                          | `"text-embedding-v4"` | Embedding model                                                                                  |
| `retrieve.timeoutMs`                      | `400`                 | Live-query embedding timeout, milliseconds                                                       |
| `retrieve.backfillTimeoutMs`              | `10000`               | Background embedding timeout, milliseconds                                                       |
| `retrieve.cacheSize`                      | `1000`                | Embedding cache entries                                                                          |
| `retrieve.minSim`                         | `0.4`                 | Vector-candidate similarity threshold                                                            |
| `retrieve.vecLimit` / `retrieve.ftsLimit` | `50` / `50`           | Vector/full-text candidate limits                                                                |
| `retrieve.ftsAndTryThreshold`             | `20`                  | OR-hit threshold for trying AND matching                                                         |
| `retrieve.andBoost`                       | `1.2`                 | AND-match weighting                                                                              |
| `retrieve.timeRangeBoost`                 | `2`                   | Weighting for in-range candidates                                                                |
| `retrieve.timeEdgeDays`                   | `2`                   | Time-range edge tolerance, days                                                                  |
| `retrieve.rrfK`                           | `60`                  | Reciprocal rank fusion (RRF) parameter                                                           |
| `retrieve.envMinGapSec`                   | `600`                 | Minimum spacing between retrieved visual observations to reduce duplicates, not capture interval |

Preloading:

| Field                                              | Default     | Purpose                                                               |
| -------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `preload.ltmMaxPerField`                           | `6`         | Long-term entries per field; single-value fields still take one       |
| `preload.ltmMaxChars`                              | `800`       | Long-term context character budget                                    |
| `preload.stmUpcomingGraceDays`                     | `2`         | Grace period after an upcoming item's date when no expiry is explicit |
| `preload.stmMaxAgeDays`                            | `90`        | Maximum active age for short-term items                               |
| `preload.recencyLambda`                            | `0.05`      | Recency decay                                                         |
| `preload.upcomingWeight` / `preload.ongoingWeight` | `1.5` / `1` | Upcoming/ongoing base weights                                         |
| `preload.urgentBoost` / `preload.urgentDays`       | `1.5` / `3` | Urgency weighting and day range                                       |
| `preload.stmMaxItems`                              | `20`        | Maximum preloaded short-term items                                    |
| `preload.stmMaxChars`                              | `1200`      | Short-term context character budget                                   |

`retrieve.maxChars` cannot exceed `retrieve.retrievedMaxChars`; `retrieve.backfillTimeoutMs` cannot be shorter than `retrieve.timeoutMs`; `segment.minTurnsBeforeGapCut` cannot exceed `segment.maxTurns`. See [Memory configuration validation](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/memory/config.ts) for complete ranges.

</details>

### Environment variables

General precedence is **environment → `config.json` → built-in defaults**. API key precedence is more specific: `DASHSCOPE_API_KEY` → `QWEN_LIVE_HARNESS_REALTIME_API_KEY` → `realtimeApiKey`. Check shell overrides if a file edit appears ineffective.

| Variable                                                  | Setting or purpose                                            |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `DASHSCOPE_API_KEY`, `QWEN_LIVE_HARNESS_REALTIME_API_KEY` | Main DashScope key                                            |
| `QWEN_LIVE_HARNESS_REALTIME_ENDPOINT`                     | `realtimeEndpoint`                                            |
| `QWEN_LIVE_HARNESS_REALTIME_MODEL`                        | `realtimeModel`                                               |
| `QWEN_LIVE_HARNESS_VOICE`                                 | `voice`                                                       |
| `QWEN_LIVE_HARNESS_BACKENDS`                              | JSON `backends`; `'[]'` explicitly disables backends          |
| `QWEN_LIVE_HARNESS_CWD`                                   | `defaultCwd`                                                  |
| `QWEN_LIVE_HARNESS_SHORTCUT`                              | `shortcut`                                                    |
| `QWEN_LIVE_HARNESS_PORT`                                  | `port`                                                        |
| `QWEN_LIVE_HARNESS_DATA_DIR`                              | Base for configuration, session logs, and default Memory      |
| `QWEN_LIVE_HARNESS_DISCOVERY_DIR`                         | Discovery base directory, independent of DATA_DIR             |
| `QWEN_LIVE_HARNESS_DISCOVERY_FILE`                        | Complete `run/daemon.json` path for a separately started Host |
| `QWEN_LIVE_HARNESS_VISUAL_SOURCE`                         | `visualInput.source`                                          |
| `QWEN_LIVE_HARNESS_VISUAL_MODE`                           | `visualInput.mode`                                            |
| `QWEN_LIVE_HARNESS_VISUAL_FPS`                            | `visualInput.fps`                                             |
| `QWEN_LIVE_HARNESS_CAMERA_RESOLUTION`                     | `cameraResolution`, such as `1280x720`                        |
| `QWEN_LIVE_HARNESS_CAMERA_SNAPSHOT_RESOLUTION`            | `cameraSnapshotResolution`, `native` or `WIDTHxHEIGHT`        |
| `QWEN_LIVE_HARNESS_VISUAL_LIVE_RESOLUTION`                | `liveResolution`, such as `1280x720`                          |
| `QWEN_LIVE_HARNESS_VISUAL_SNAPSHOT_RESOLUTION`            | `snapshotResolution`, `native` or `WIDTHxHEIGHT`              |
| `QWEN_LIVE_HARNESS_PROACTIVE_ENABLED`                     | `proactive.enabled`; accepts `true` / `1` / `false` / `0`     |
| `QWEN_LIVE_HARNESS_LOG_LEVEL`                             | `debug` / `info` / `warn` / `error`; default `info`           |

Configuration without `backends` supports `serveUrl` / `serveToken` and `QWEN_LIVE_HARNESS_SERVE_URL` / `QWEN_SERVER_TOKEN`. Explicit backend arrays describe multi-backend and no-backend setups.

Installed desktop registration records absolute Node/CLI paths, PATH, configuration/discovery directories, and working directory, not arbitrary shell environment variables. Prefer the configuration file for settings needed when double-clicking Host; a variable present in one terminal may not exist in desktop startup.

`DATA_DIR` moves configuration and default data, **not** the discovery base, which remains `~/.qwen-live-harness` unless overridden. For example, an installed CLI can use an isolated configuration:

```sh
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-work"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
qwen-live-harness init
qwen-live-harness
```

For source development, replace the final two commands with `npm run init` and `npm start`. `DATA_DIR` is environment-only; there is no `dataDir` configuration field. `discoveryDir` can be configured and overridden by `QWEN_LIVE_HARNESS_DISCOVERY_DIR`. A manually connected Host uses `QWEN_LIVE_HARNESS_DISCOVERY_FILE` with the complete discovery-file path.

### Run archives and offline inspection

`--debug` records main, Monitor, search, visual-analysis and notification connections plus runtime/control events in `<dataDir>/debug/run-*`. Each contains `manifest.json`, append-only `events.jsonl` and `media/`. Known credentials are redacted, but prompts, Memory, tool data, voices and images can still expose private information; inspect before sharing.

Events carry run-wide `globalSeq`, per-connection `connectionSeq`, connection kind/ID, timestamps, direction and payload. `archive.connection_registered` and session/config snapshots are metadata, not extra requests. Actual outbound attempts are `wire.send`; a matching `wire.send_result:sent` means local socket acceptance, **not provider acknowledgement**. Missing results are unconfirmed; `failed_or_uncertain` does not prove no side effects. Media references record exact relative paths, offsets, lengths and SHA-256 hashes.

Retention keeps the **10 newest finished runs**, at **512 MiB per run**; active runs are protected. Check manifest state (`recording`, `closed`, `incomplete`), warnings and counts. Capacity limits, dropped events or storage errors can make records incomplete without ending the call; write failure can also prevent manifest updates. Missing input cannot be recovered afterward.

From the repository root:

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example
```

The default summary validates sequences/send outcomes/media and reports available `sess_*` IDs without printing private bodies. Export a selected connection to a **new directory outside the archive**:

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example \
  --connection conn-000001 --output /path/to/new-export
```

Export includes `requests.json`, `responses.json`, selected events/media and an inspection summary; it preserves uncertainty/redaction labels and restores media bytes in explicit encodings. It rejects unsafe paths/symlinks and never overwrites an existing destination. Exported content is private.

Despite the filename, this is **offline inspection only**: it does not load API credentials, open an API/device, or execute recorded tools or backend commands. It cannot guarantee the same future model response.

### Monitor diagnostic archives

With `--debug` or `QWEN_LIVE_HARNESS_LOG_LEVEL=debug`, all Monitor modalities archive actual inference input separately under the system temporary directory. Logs `proactive.monitor_debug_started` / `proactive.monitor_request_saved` show exact paths. Rebuilding a WebSocket keeps the logical Monitor's directory.

```text
qwen-live-harness-monitor-debug/
  monitor-<time>-<id>/
    monitor.json
    requests/000001/
      request.json
      image-0001.jpg   # Only when this round includes images
      input.wav
      response.json
```

- `request.json.events` is the ordered append/commit/response wire sequence. `session` is an initialization snapshot, **not repeated instructions**. Task text appears in the first request's `response.instructions`; `taskTextIncluded` records this. `transportGeneration` and `previousRequest` separate connection histories.
- JPEGs and `input.wav` contain successful socket writes, excluding cleared input, not a continuous recording. WAV is mono PCM16/16 kHz, including any carrier silence. Audio offsets exclude its header; each append records offset, length and `origin` (`microphone`, `protocol_silence`, `unknown`). `audioSummary` breaks down bytes by origin, not energy or detected events. Send time may differ from capture time.
- `response.json` includes raw/parsed decisions and available session, response, event IDs and usage. Preserve missing IDs as missing; one round's WAV is not the entire server-side conversation history.
- Retain the **10 newest Monitor directories across all modalities**, not ten requests or a fixed disk quota. Evicted active monitors continue but stop archiving. Private permissions and a 32 MiB pending-write budget bound recording; failures can leave incomplete evidence without ending the call.
- Check WAV/JPEG/JSON before sharing. Credential redaction does not remove secrets in voices, pixels or task text; non-debug input cannot be recreated.

#### Scheduler decisions and session JSONL

Debug session JSONL under `<dataDir>/sessions/` uses `type:"proactive.debug"` and `payload.event`:

| Events                                                                           | Evidence                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `monitor_image_sent`, `monitor_commit`, `monitor_committed`                      | Frame hashes / successful writes / provider commit ACK; queued capture alone is not delivery                                       |
| `monitor_chunk_prepared`, `monitor_chunk_dropped`, `monitor_input_dropped`       | Capture ranges, frame counts, incomplete/gapped/invalidated inputs and local eviction                                              |
| `monitor_result`, `evaluation_decision`                                          | Model output versus scheduler decisions: `notification_accepted`, `suppressed_awaiting_false`, `rearmed_false`, `ignored_cooldown` |
| `cooldown_started`, `cooldown_resumed`, `cooldown_audio_dropped`, `buffer_reset` | Cooldown and dropped-input metadata, not an archive of discarded sound                                                             |

These event names use the `proactive.` prefix. Match task ID/generation first, then evaluation, transport generation and available provider IDs; timestamps alone can mix tasks. Metadata is bounded and does not recover media that was never sent/archived. Implementation: [monitor-debug-store.ts](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/proactive/monitor-debug-store.ts).

## Packaging and releases

The root workspace is private; this directory publishes `qwen-live-harness`, not Electron Host. Builds generate `dist/LICENSE` from root LICENSE without rewriting a package-root license. The tarball contains runtime artifacts and required license/provenance notices; `npm run check:package` verifies the actual package and installed command.

Public npm and signed Host releases must match versions and protocol. The [Host development guide](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md#release-maintenance) covers building, signing, notarization, GitHub Releases, OSS, and npm publication. Everyday source debugging does not require publishing or changing installer trust rules.

The standalone snapshot originated in [Qwen Code PR #11369](https://github.com/QwenLM/qwen-code/pull/11369), source commit `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`, retaining source copyrights and Apache-2.0 notices. Earlier product names/data are not automatically migrated; new default data lives under `~/.qwen-live-harness`.

The bundled HTTP SDK license and [pinned peer source notices](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/vendor/qwen-code-peer/README.md) remain required distribution notices, not optional historical docs.

License: [Apache License 2.0](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/LICENSE).
