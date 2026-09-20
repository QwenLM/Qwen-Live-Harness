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

| Location                                                                                                                                                                                                                                                         | Responsibility                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`src/index.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/index.ts), [`src/cli-startup.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/cli-startup.ts)                     | CLI entry point, instance reuse, startup, and shutdown                            |
| [`src/config.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/config.ts), [`src/init.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/init.ts)                                 | Configuration validation, environment precedence, and initialization              |
| [`src/peer-setup.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/peer-setup.ts), [`src/peer-diagnostics.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/peer-diagnostics.ts) | Incremental Qwen terminal setup and read-only diagnostics                         |
| [`src/daemon.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/daemon.ts)                                                                                                                                                | Service assembly, Host HTTP/WebSocket endpoints, and cleanup                      |
| [`src/host/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/host)                                                                                                                                                         | Host protocol, discovery, call state, and installer                               |
| [`src/orchestrator/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/orchestrator)                                                                                                                                         | Call lifecycle, tool dispatch, backend events, and notification queue             |
| [`src/realtime/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/realtime)                                                                                                                                                 | Main Realtime protocol, system prompts, and independent text search connections   |
| [`src/adaptor/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/adaptor)                                                                                                                                                   | Backend adapters, capability declarations, and event normalization                |
| [`src/tools/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/tools)                                                                                                                                                       | Model tool schemas, receipts, and session/job/asset handles                       |
| [`src/permissions/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/permissions)                                                                                                                                           | Forwarding and answering actual backend permission requests                       |
| [`src/proactive/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/proactive)                                                                                                                                               | Monitoring, timers, triggers, and FIFO notifications                              |
| [`src/memory/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/memory)                                                                                                                                                     | Local memory libraries, retrieval, consolidation, and optional visual observation |
| [`src/subagents/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/subagents)                                                                                                                                               | Subagent status, details, and manual stop API                                     |
| [`src/log/`](https://github.com/QwenLM/Qwen-Live-Harness/tree/main/packages/qwen-live-harness/src/log), [`src/logger.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/logger.ts)                                        | Session records and runtime diagnostics                                           |
| [`src/i18n/messages.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/i18n/messages.ts)                                                                                                                                  | Shared English/Chinese fixed CLI and Host UI text                                 |

A call primarily follows `LiveDaemon → LiveHostCoordinator → LiveSession → Realtime / BackendAdaptor`. Qwen Serve is a REST/SSE backend that Live can start or connect to; ACP and no-backend mode do not require it.

## Build and test

```bash
npm run build
npm run typecheck
npm run test:daemon
npm run test:scripts
npm run test:integration
```

To run a single daemon test file:

```bash
npm test --workspace qwen-live-harness -- src/orchestrator/live-session.test.ts
```

Additional checks are `npm run lint`, `npm run format:check`, `npm run check:boundaries`, and `npm run check:package`. The last command checks the actual npm tarball, installed command, and package boundaries. See the [Host guide](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md) for desktop builds, type checks, and tests.

Default unit and protocol tests use fakes and local test services, without real model accounts. Tests that need real accounts run separately and explicitly. Keep paid API calls, device permission prompts, and personal credentials out of the default test suite.

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

Report announcements wait for user speech, foreground responses, and device playback to finish, then use an independent response with no tool permissions. A report is not a new user instruction, permission answer, or verified completion event. Results for associated managed jobs are still announced through the original backend events, avoiding duplicate completion reports. Muting output preserves the text; interrupted or failed announcements are not automatically replayed.

Each report is limited to 2,000 characters. Reception limits are 20 per minute overall and 6 per source socket; attribution and speech queues hold 32 each; display history holds 100. Addresses and associations expire at call end, and old messages are not replayed. Previous-call reports remain visible until the next call starts.

Implementation: [`qwen-peer-discovery.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-discovery.ts), [`qwen-peer-controller.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-controller.ts), [`qwen-peer-reports.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-reports.ts), and [`session-reports.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/orchestrator/session-reports.ts). The peer SDK includes a pinned copy of the [official Node-only source](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/vendor/qwen-code-peer/README.md), with provenance checks. Peer transport supports macOS/Linux; full desktop interaction still requires macOS. Terminal protocol tests use Qwen Code 0.23.3; older versions may not support these capabilities. See the [M3 acceptance checklist](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/docs/m3-acceptance.md) for integration verification.

## Protocols and capability boundaries

### Model tools and MCP

Main Omni uses daemon-defined tools for Appshot, Memory, Proactive, and delegation. It does not directly receive every backend tool.

This package has no independent MCP configuration or management layer. Configure MCP in the background Harness; availability inside ACP sessions depends on that backend. ACP session creation/loading currently sends `mcpServers: []`. Adding MCP support requires a real execution and permission channel, not only new Realtime tool instructions.

The main assistant identifies as **Qwen Omni**, with or without a backend. It answers conversational requests that need no external information directly and prefers `web_search` for simple public-information lookups. File operations, commands, complex tasks, and work explicitly assigned to an agent go through the Harness.

`web_search` is available with or without a backend and has no local model-name allowlist. Its independent text-only Realtime connection reuses the main model ID, including aliases, endpoint, and API key exactly. There is no separate search model configuration; native search support is determined by the service. See [`src/realtime/web-search.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/realtime/web-search.ts).

The tool immediately returns `accepted + taskId`. Searches run independently and can run concurrently, each with a 25-second timeout. Only the query is sent, without microphone audio, screenshots, Memory, or context from other work sessions. Service metadata indicates whether a search occurred; an unknown status is not confirmation of a live search.

Results enter the Injector's `search_result` channel and wait for user speech, foreground responses, and playback to finish. Main Omni composes the answer from query/answer/searchStatus rather than reading the raw result verbatim. Each result is sent as quoted data in a `[NOTIFICATION]` user-context message, not as a new user request. The resulting response has no tool permissions; webpage text cannot authorize another search, delegation, or Memory update. Search tasks use `kind: "search"`, can be cancelled independently, and distinguish waiting for delivery from completed delivery.

Main-conversation system instructions remain fixed for the call. Each connection sends them once in `session.update`; `response.create` does not repeat or override them. Subagent results use `conversation.item.create` with typed, quoted data. Memory updates use replaceable `[MEMORY_CONTEXT]` user snapshots rather than rewriting the system prompt; disabling Memory sends an empty disabled snapshot. Reconnection restores only the latest snapshot, and tool-list changes use a tools-only `session.update`. Earlier messages remain in the service's current conversation.

Tools execute only after a completed `response.done` confirms their final IDs, names, arguments, and status. A result must be acknowledged before tool continuation. A matching `Unknown function call id` or a 10-second result-ACK timeout stops that continuation and records a silent delivery diagnostic without repeating the action or closing the call. Unmatched protocol/configuration errors use their own failure handling. Receipt rejection does not prove the task failed or authorize another execution.

Accepted asynchronous receipts require a separate `tool_continuation` response. After the service acknowledges a search, Appshot analysis, managed handoff, or Proactive creation receipt, the daemon waits for that response to finish before injecting the final visual, search, backend, or Monitor notification. This separates task acceptance from result delivery; it does not repeat the task or rewrite system instructions.

Only duplicate confirmation audio is suppressed, and only when the tool chain already produced a preamble and **every tool in the parent response** successfully admitted an eligible asynchronous task: `web_search`, an accepted Appshot visual analysis, a managed `handoff` without warnings, or a committed `create_proactive_monitor` / `create_live_narration`. The model still completes the receipt response; its text remains in provider history and diagnostic transcripts with `audioSuppressed:true`, but is not recorded as user-heard dialogue in Memory, handoff context, or reconnect history. Without a preceding audio preamble, with errors or warnings, or with mixed query tools, confirmation remains audible. Terminal instruction deliveries, permission responses, `session_create`, timers, and task updates/cancellation are not eligible for this suppression. A late receipt superseded by a newer user turn is drained separately without audio or the old turn's tool authority; genuine new-user answers and final task-result notifications are not muted by that drain.

If a receipt continuation repeats a request that was already accepted, the runtime returns the original receipt instead of starting another task. This guard applies only to that continuation; different requests in the same chain and new requests from the user can still execute. Reusing a receipt preserves its warnings.

If native search fails and a backend is configured, the runtime creates an isolated session on the default backend, passing only the original query and read-only public-information constraints. It uses the existing handoff, task-recording, and permission flow. Failed output and webpage instructions do not authorize further actions, and the main model does not start a duplicate fallback. Without a backend, the search reports failure. The search record tracks the fallback, while backend events update the delegated job. End call or a new conversation cancels unfinished searches, withdraws pending results, and stops that call's automatic fallback queries; unrelated jobs follow their normal lifecycle. A cancellation request still requires confirmation from the backend.

### Audio and visual input

The main session requests `semantic_vad`, `create_response: false`, and `interrupt_response: true`: the service detects turns, while the daemon schedules `response.create`. Memory updates and tool continuations leave the main VAD mode unchanged. Independent monitors submit media chunks manually, and search uses text only. Their `turn_detection: null` setting does not disable VAD in the main conversation.

Transport uses mono PCM16: 16 kHz microphone input and **24 kHz model output** (`session.audio.output.format.sample_rate: 24000`). Host resamples output to the device's actual rate; do not force the system output clock to match the model. Restart both components after updating; `session.start.outputSampleRate` records the playback input rate.

There is one selected visual source and capture mode:

| Path                     | Content and scope                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Live Feed                | Continuous frames from the selected camera or full selected display to main Omni                                                 |
| On Demand Appshot        | A snapshot goes to an independent visual-analysis subagent; the main model receives text evidence and an asset/metadata receipt  |
| Proactive visual monitor | Selected camera or full-display frames to an independent Monitor, including independent sampling in On Demand mode               |
| Optional visual Memory   | Reuses Live Feed frames or captures the selected display/camera separately in On Demand mode; stores processed text observations |

Appshot captures a snapshot and returns an asynchronous `accepted + taskId` receipt with its image asset. A `kind: "visual"` subagent analyzes the encoded snapshot using the main model/endpoint/key, with no tools or native search. It returns the result through a `visual_result` notification that cannot authorize tools. This works without a background Harness. In this path, main Realtime receives text evidence rather than the image itself; an asset handle alone does not provide visual evidence.

The visual helper sends two one-second protocol-silence segments, each followed by the same still JPEG. It commits once, waits for acknowledgement, then requests text inference with the visual question in `response.instructions`. The duplicate frames satisfy the video input format; they do not indicate motion. The fixed system prompt is sent once, without private Memory or unrelated conversation. Analysis has a 25-second deadline and is cancelled when the task or call ends. Failure does not trigger fallback to a coding agent. Analyses can run in parallel; completed results share the read-only result FIFO and playback acknowledgements. Subagents shows queued and running analyses and preserves text output when speech is muted. Screen assets retain their original PNG, while model input follows the snapshot transport limits.

The optional Appshot `query` supplies the current visual question. If omitted, it uses the current turn's final transcript when available, or requests a general description. Only successful task acceptance can suppress duplicate confirmation audio. The result prompt tells the model to preserve uncertainty, avoid inferring a blank desktop from `app=Unknown`, and treat screenshot text as evidence rather than instructions. It also prohibits repeating accepted requests or inventing illegible details. `visual.analysis` and `visual.delivery` diagnostics correlate the subagent and main response without logging image bytes.

Protocol types and limits are defined in [`host/types.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/host/types.ts), [`realtime-session.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/realtime/realtime-session.ts), and Host's shared protocol. Current Host protocol is v9:

- Input/output is bound to a call epoch, and output also to `outputId`. Preserve these identities through playback start, completion, and clearing; stale acknowledgements must not advance a new turn.
- Capabilities negotiate extensions such as display capture and audio-end markers. An end-marker-capable Host acknowledges completion only after processing that output's marker and all queued audio.
- Proactive notifications play FIFO after foreground responses and device output finish. Capture and event queueing continue. Updating or cancelling a task withdraws its old events.
- Capturing the full display does not guarantee native resolution. Live frames and snapshot assets have different size and transport limits. Discard late results after the source, display, or epoch changes.

### Logs and shared text

Use `--debug` to correlate Host connections, epochs, capture dimensions, frame hashes, tool results, and playback timing. Session JSONL, Memory databases, and diagnostic files serve different purposes; each may contain user conversations or task content.

Search-result delivery records `search.delivery` in session JSONL and `web_search.delivery` in debug output. Correlate the task, provider session, and response IDs across `queued`, `requested`, `response_started`, `transcript`, `audio_started`, `response_done`, and `finished` phases. `audio_started` means audio was forwarded to Host, not proof that the user heard it; completed delivery also requires playback acknowledgement. If a result response completes without playable audio, the result remains in Subagents with the `search.answerUnspoken` activity, and a nonfatal `search_answer_unspoken` diagnostic is recorded instead of claiming it was spoken.

Debug mode also creates cross-connection [run archives](#run-archives-and-offline-inspection), separate from session JSONL and per-Monitor archives. Audio, visual, and combined Monitor archives contain actual requests and original media. Only the latest ten Monitor directories are retained; this limits directory count, not total disk usage. See [Monitor diagnostic archives](#monitor-diagnostic-archives), and check their contents before sharing.

All fixed UI/init text lives in [`src/i18n/messages.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/i18n/messages.ts), with paired `en` / `zh-CN` entries and matching placeholders. Host reuses it at build time. System prompts and raw backend output are not UI translation-table entries.

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

### Spoken permissions and persistent approval

Main Omni generates permission questions in the current real conversation's language, falling back to `config.language` only when conversation language cannot be determined. English backend titles, commands, and paths are approval data, not language instructions or user consent. The independent permission response cannot call tools or substitute a progress announcement for a question. A later explicit user answer is handled by ordinary conversation through `respond_permission`. The original action remains visible in subagent details.

Completion/failure notifications use an independent `task_result` response. Runtime supplies the real status, task, and summary; the model briefly explains them in the current conversation's language using trusted language metadata. It must not read internal IDs, raw paths, or Markdown aloud or call tools through the notification. Recent real-user language samples can persist across calls only for language selection, not as result facts. The notification envelope carries trusted language metadata; it never modifies system instructions, and a newer real user turn determines the language of a merged response.

After an actual permission request, ordinary `allow` approves only that request. Use `allow_always` only when the user explicitly asks for ongoing permission. This applies to ACP and Qwen Serve backends with permission forwarding.

`allow_always` prefers persistent options offered and stored by the backend, such as all file edits or this command within this project. When several exist, the first is used; Qwen project-scoped options precede user-scoped options. This is not unconditional permission for all operations.

If the backend offers no persistent option, or hides it for the current request, Live falls back to one-time approval rather than denial. Only in this case does Live also retain a **30-minute, same-action-only** local rule for the current session. Similar but different actions are not covered.

A later explicit `deny` removes the matching local Live rule, not permissions already persisted by the backend. Revoke those in the backend; they are not limited by Live's 30-minute rule.

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

When a foreground Proactive response finishes with `status: completed` but produces no audio, including `remain_silent`, the same delivery may use **one** independent speech fallback. It does not create another Monitor, increment its trigger count, or re-evaluate the evidence. Failed or cancelled primary responses retain their separate handling.

If there is a `remain_silent` call, its function result must be acknowledged and its silent receipt continuation drained first. The fallback then waits through the Injector's FIFO, foreground-response, and playback gates. It uses the same endpoint, model, key, and voice as the main conversation, with 24 kHz PCM, `smooth_output:false`, no tools/search, and `turn_detection:null`. It receives a short fixed policy, the quoted observation summary, and current conversation language—not raw media, Memory, the requested trigger condition, or intervention instructions. This is speech delivery, not independent verification of the observation. Its `response.create` carries no instructions.

Audio is buffered until the entire response succeeds. The helper has a 20-second request timeout and a 20-second mono PCM budget (960,000 bytes). `maxWaitTtsSec` limits preparation plus playback for the attempt; a shorter configured deadline can expire first and is not extended. Fallback failure or timeout retires the delivery as `undelivered` without failing a repeat monitor.

For the independent fallback, notification state and task status are separate:

| Notification state | Meaning                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `queued`           | Waiting in order, including an unfinished receipt drain or transport recovery  |
| `preparing`        | Preparing a response; generated/buffered audio is not proof of playback        |
| `speaking`         | Host has actually acknowledged playback start                                  |
| `delivered`        | Successful generation and Host playback completion have both been confirmed    |
| `undelivered`      | This announcement was not fully delivered; it must not be represented as heard |

A one-shot task can be `completed` while its notification is `undelivered`: detection ended, but the announcement did not finish. A repeat monitor continues after a fallback delivery failure. User speech, output mute, task cancellation, or End call invalidates a queued fallback. Connection recovery can preserve a fallback that has not started, still waiting behind the receipt barrier. Once generation or playback begins, interruption, mute, cancellation, stop, or recovery aborts it without replaying the old announcement.

On the primary path, `preparing` and `speaking` distinguish generation from actual playback. While output is muted, an event can be marked as consumed without playback and will not replay on unmute. A consumed or completed event is therefore **not evidence that the user heard it**; the stricter `delivered` condition above applies to the independent fallback. Debug events `proactive.fallback_queued`, `proactive.fallback_started`, `proactive.fallback_audio_ready`, `proactive.fallback_delivered`, `proactive.fallback_undelivered`, and `proactive.delivery_undelivered` correlate the same task/delivery IDs without adding a trigger.

### Memory model connections

The updater consolidates long- and short-term information from conversations. A separate, optional observer creates environment memories from visual input. These are independent paths: the updater does not produce environment-observation records, and disabling it does not delete those memories or disable observer capture and environment retrieval.

Updater and observer use same-region `/compatible-mode/v1/chat/completions` derived from the Realtime endpoint by default; vector retrieval uses `/compatible-mode/v1/embeddings`. The updater defaults to `qwen3.7-plus`; an omitted `observer.model` inherits it. Visual observation requires image support.

`updater.baseUrl` / `observer.baseUrl` override the respective HTTP(S) compatible API base URL, without a `/chat/completions` suffix. `apiKeyEnv` names a credential environment variable and requires its corresponding `baseUrl`. A custom base URL with an empty `apiKeyEnv` still receives the main API key; confirm that you intend to send that credential to the service. Embeddings always use the main DashScope connection.

### Memory tuning

All fields below are under `memory`. Omitted values use these defaults. Users typically need only the toggle, model, directory, and observation interval. Context-entry and character limits do not delete local history or limit the entire database.

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

Debug runs write to `<dataDir>/debug/run-*`, separately from the temporary per-Monitor archives below. Each run archive records the observed main, Monitor, search, visual-analysis, and notification model connections, plus runtime/control events. Known credential fields, configured secrets, and recognized credential text patterns are redacted. This does not inspect images or audio for secrets: prompts, Memory context, tool arguments/results, transcripts, and media may still contain private information. Review the archive before sharing it.

Each run contains `manifest.json`, append-only `events.jsonl`, and `media/`. Events retain a run-wide `globalSeq`, per-connection `connectionSeq`, connection kind/ID, wall time, monotonic time, direction, and recorded payload. `archive.connection_registered` holds connection metadata; it is not another model request. Actual outbound requests are `wire.send` records. Their matching `wire.send_result` is `sent` or `failed_or_uncertain`: `sent` means the local socket accepted the write, not that the provider acknowledged it. No result means `unconfirmed`. Provider acknowledgements remain separate inbound events.

Media references contain a relative path, byte offset, byte length, SHA-256, kind, and encoding. They identify exact archived byte ranges, not reconstructed recordings. Session/configuration snapshots provide context; they do not mean instructions were resent each round. To determine what the client attempted to send, inspect the recorded wire sequence and check whether the archive is complete.

The default budget is **512 MiB per run**, with the **10 newest finished runs** retained, including incomplete captures. Active runs are protected and can temporarily bring the total above ten. `manifest.json` records the state (`recording`, `closed`, or `incomplete`), warnings, and counters. Reaching a limit, dropping an event, or encountering a storage error makes the archive incomplete without failing the call. A write failure can also prevent a manifest update, so check runtime warnings and missing files as well as the status field. Input that was not archived cannot be recovered afterward.

From the repository root, inspect a run without printing its prompts or transcripts:

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example
```

Use a connection ID from that summary to export into a **new directory outside the archive**:

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example \
  --connection conn-000001 --output /path/to/new-export
```

The helper checks event sequences, send outcomes, media bounds and hashes, and rejects unsafe paths or symlinks. The summary lists observed connection states, validated provider `sess_*` IDs when available, and unique response counts without printing message bodies. It exports `requests.json`, `responses.json`, selected `events.jsonl`, copied media ranges, and an inspection/manifest summary; base64 media is restored in the JSON requests/responses. Original byte arrays use explicit `$binary` envelopes, and redaction flags remain attached. Failed or unconfirmed sends stay labeled, and incomplete captures are never presented as complete. Existing output directories are not overwritten. Exported files contain sensitive content; inspect them before sharing.

Despite its filename, the helper is **offline only**. It does not read an API key, contact an endpoint, start a device, execute recorded function calls, or rerun backend commands. Tool histories are exported as data for analysis, not executed. The archive cannot guarantee that a later request will reproduce the same model output or server state.

### Monitor diagnostic archives

With daemon `--debug` or `QWEN_LIVE_HARNESS_LOG_LEVEL=debug`, audio-only, video-only, and combined monitors archive actual requests under the system temporary directory. Non-debug runs do not archive media, and unsaved input cannot be recovered afterward. From source:

```sh
npm start -- --debug
```

Archives are per inference round, not continuous recordings:

```text
qwen-live-harness-monitor-debug/
  monitor-<time>-<id>/
    monitor.json
    requests/000001/
      request.json
      image-0001.jpg   # Present only for rounds containing images
      input.wav
      response.json
```

- `proactive.monitor_debug_started` and `proactive.monitor_request_saved` log absolute directories. Rebuilding a Monitor WebSocket keeps the same Monitor directory.
- JPEGs are frames successfully written to the model connection. `input.wav` contains the mono 16 kHz PCM16 successfully appended before that commit and not discarded by `input_audio_buffer.clear`. Audio parts are concatenated in send order, including any protocol silence. This is not an uninterrupted microphone recording. Audio offsets exclude the WAV header.
- All Monitor modalities use the same `request.json.events` layout: individual audio/image append events, `input_audio_buffer.commit`, and `response.create`. Each audio append points to `input.wav` with its byte offset, length, and `origin`. `origin` is `microphone`, `protocol_silence` for the silent track required by video-only input, or `unknown`. `audioSummary` lists `totalBytes`, `microphoneBytes`, `protocolSilenceBytes`, and `unknownBytes`. These diagnostic fields are not sent to the model and say nothing about audio energy or detected events. Media buffered during a handshake or slow inference may be sent later, so send time and capture time can differ.
- `request.json` records initialization settings, event order, frame hashes, audio offsets, and `previousRequest`. Find task text in the first request's `response.create` event at `response.instructions`; it is absent from later response requests, and there is no separate task-only user item. `transportGeneration` identifies connection history boundaries. `previousRequest` links only within a transport and resets after reconnection. Server context can retain earlier submitted media and replies; a single WAV is not the entire context visible to the model.
- `request.json.session` is an initialization snapshot included for standalone inspection, **not a replay of system instructions or task text each round**. Event IDs in that snapshot stay the same within a transport. The actual incremental wire sequence is in `events`: media append, commit, then `response.create` after the commit acknowledgement. Only a new transport resends initialization, with task text included once in its first media inference request; the system prompt stays in the initial `session.update`.
- Valid `providerSessionId` values are recorded when available. `response.json` contains raw action text and parsed results, plus `responseId`, `eventId`, and `usage` when provided. Request events preserve available send IDs. Do not infer missing identifiers; usage is not equivalent to useful microphone duration.
- Correlate Host, daemon, and `proactive.monitor_image_sent` frame hashes. `proactive.monitor_commit` counts successful socket writes; `proactive.monitor_committed` records service acknowledgement. Queued or dropped frames are not evidence of delivery.
- `proactive.monitor_chunk_prepared` records capture ranges and actual frame counts. `proactive.monitor_chunk_dropped` records missing images, capture gaps, invalidated pending chunks, or uncertain media/commit sends. `proactive.monitor_input_dropped` aggregates local eviction counts, bytes, and time ranges. These debug session events distinguish missing complete input from a model `wait` decision.
- `proactive.monitor_ready` reports `streaming_buffers` as the input path. `proactive.monitor_response_requested` records `taskTextIncluded`, which is true only for the first media inference on each connection, so task text is distinguishable from the fixed system prompt.
- Retention keeps the **10 newest Monitor directories across all modalities**. This is a directory-count limit, not a per-modality allowance, request limit, or total disk quota. Removing an archive does not stop its Monitor, but that Monitor no longer writes to the archive. Directories and files use private permissions; pending and queued writes have a 32 MiB memory budget. Disk faults or budget limits can make archives incomplete without ending a call.
- JSON redacts connection credential fields and known API keys, not every secret spoken, shown, or written by the user. Inspect WAV, JPEG, and JSON before sharing, not just terminal output. Do not share the whole data directory.

#### Scheduler decisions and session JSONL

Media archives show only input actually sent to an inference. Audio dropped during cooldown is not in WAV files. Debug mode also prints key Proactive metadata and stores it in session JSONL under `<dataDir>/sessions/`. Records have `type: "proactive.debug"` and the concrete event name in `payload.event`:

- `proactive.monitor_commit`, `proactive.monitor_committed`, and `proactive.monitor_result`: submission, service acknowledgement, and inference result.
- `proactive.evaluation_decision`, such as `notification_accepted`, `suppressed_awaiting_false`, `rearmed_false`, or `ignored_cooldown`: separates a model trigger from permission to deliver a notification.
- `proactive.cooldown_started`, `proactive.cooldown_resumed`, `proactive.cooldown_audio_dropped`, and `proactive.buffer_reset`: cooldown, dropped-audio statistics, and pending-buffer cleanup, not separate recordings of discarded audio.

First match `taskId` and task generation (`taskGeneration` for Monitor events; `generation` for some scheduler events), then correlate nearby results by `evaluation`, `transportGeneration`, and available `providerSessionId` / `responseId`. Not every event has every identifier; timestamps alone can mix tasks or connections. JSONL holds bounded diagnostic metadata, not per-frame media or input from before debug was enabled.

See [`monitor-debug-store.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/proactive/monitor-debug-store.ts). For Host-private failure logs and device diagnostics, see [Logs and shared text](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md#logs-and-shared-text).

## Packaging and releases

The root workspace is marked `private` and is not published to npm. This directory publishes the `qwen-live-harness` package, whose tarball contains the built `dist` files and license, not Electron Host. `npm run check:package` verifies that package boundary.

Public npm and signed Host releases must match versions and protocol. The [Host development guide](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md#release-maintenance) covers building, signing, notarization, GitHub Releases, OSS, and npm publication. Everyday source debugging does not require publishing or changing installer trust rules.

License: [Apache License 2.0](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/LICENSE).
