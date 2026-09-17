# Qwen Live Harness · Daemon Development Guide

[简体中文](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/README_ZH.md) | English

This directory is the `qwen-live-harness` npm package. It owns model connections, conversation scheduling, delegation, Proactive, and Memory. The separate macOS Host provides the desktop UI, system permissions, and device capture.

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

`npm run init` builds the daemon, opens the source initialization wizard, and saves configuration. It does not download or install Host or register an installed desktop runtime. You can select a coding agent or continue without a background Harness.

For Qwen Code, initialization defaults to a Live-managed local Qwen Serve. You can instead connect to an existing local service or select ACP. Initialization only saves the settings; the service starts with the daemon. See [Qwen terminal integration](#qwen-terminal-integration) for the distinction between terminal discovery and authorization.

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

A call primarily follows `LiveDaemon → LiveHostCoordinator → LiveSession → Realtime / BackendAdaptor`. Qwen Serve is a REST/SSE backend target that Live can launch or connect to; it is not required for ACP or no-backend mode.

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

Default unit and protocol tests use fakes and local test services, not real model accounts. Real-account checks are separate, explicit verification steps; do not add paid APIs, device permission prompts, or personal credentials to ordinary tests.

## Isolated configuration and daemon-only debugging

The default configuration is `~/.qwen-live-harness/config.json`; the data directory also holds Memory and session data.

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
- Normal process shutdown writes an instance-specific stop marker, allowing a Host still handshaking or reconnecting to exit. A stale marker must not close a new instance. An ordinary disconnection is not a quit request.
- End call stops the current interaction and Proactive capture; delegated backend jobs may continue. Full application shutdown cleans up daemon-owned resources, ACP children, and managed Qwen Serve, not independently running user services or terminals. Shutdown retries remain bound to the original authenticated instance.

See [`startup.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/startup.ts), [`startup-lock.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/startup-lock.ts), [`host/discovery.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/host/discovery.ts), and [`lifecycle.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/lifecycle.ts).

## Integrate a background Harness

For an ACP-compatible agent, configuring `kind: "acp"`, `command`, `args`, and any required `env` is usually enough. To include it in initialization discovery, extend [`agent-detector.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/agent-detector.ts) and its tests.

For a new protocol, implement [`BackendAdaptor`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/types.ts):

1. Add an adapter under `src/adaptor/` implementing preflight, session management, `prompt`, events, cancellation, permission responses, and `close`.
2. If needed, extend `BackendConfig`, validation, and `buildAdaptor` in [`daemon.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/daemon.ts). Keep backend-specific branching out of the call scheduler.
3. Declare actual behavior in `capabilities()`, add protocol tests, and verify delegation, event correlation, permissions, and cleanup.

Use [`AcpAdaptor`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/acp-adaptor.ts) and [`QwenCodeAdaptor`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-code-adaptor.ts) as references. The latter connects to Qwen Serve over REST/SSE. [`ManagedQwenServe`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/managed-qwen-serve.ts) handles managed startup; an existing external service remains user-owned.

Preserve these contracts:

- `prompt()` returns acceptance/queueing, not a final result. Confirm completion with events such as `turn_complete`, using stable `jobRef` or explicit joined-turn identifiers. Do not infer completion.
- Declare capabilities such as `steering`, `imageInput`, and `permissionForwarding` accurately. Do not claim an image reached a backend that cannot accept it. Continuous backend observation currently requires `eventDelivery: "stream"`; declaring another delivery mode does not implement its consumer.
- Permissions come only from actual backend requests. Do not manufacture an approval dialog for an ordinary write failure or silently approve it. Cancelling an unknown job must not stop unrelated work in the same session.
- `close()` cleans up processes, subscriptions, and requests owned by the adapter, not independent user services.

`backends: []` explicitly selects no-backend mode without creating a placeholder agent. Conversation, visual input, Proactive, and Memory remain available; backend tools return `no_backend`. An unavailable configured default backend still fails startup rather than silently enabling no-backend mode.

## Qwen terminal integration

This path connects existing **interactive Qwen Code terminal sessions** through Qwen's public peer protocol. It does not read arbitrary terminal stdout or take ownership of external terminal processes. Discovery, text delivery, and report reception are three separately configured capabilities.

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

Put this entry in `backends` and replace `command` with the executable's real path. `managedServe` cannot be combined with `baseUrl`, `serveUrl`, or `token`; the working directory comes from `defaultCwd`. Qwen keeps its own model authentication and settings. Live does not configure its model or authorize terminal messaging on the user's behalf.

Choosing either Serve mode also saves read-only `peerDiscovery` for the current `QWEN_HOME`, defaulting to `~/.qwen`. It neither grants text-delivery permission nor enables reports. For a manually configured remote Serve, the local peer directory still discovers local terminals, not remote terminals.

<a id="terminal-setup-and-diagnostics-m3-stage-4"></a>

### Incremental setup and read-only diagnostics

With an existing Live configuration, run from the repository root:

```bash
npm run build
node packages/qwen-live-harness/dist/index.js init --peers
node packages/qwen-live-harness/dist/index.js doctor --peers
```

Installed equivalents are `qwen-live-harness init --peers` and `qwen-live-harness doctor --peers`. The source launcher does not currently forward `--peers`, so use the built entry point above.

`init --peers` edits only the selected `qwen-code` backend's `peerDiscovery`. It can select an existing backend or add one connected to an existing Serve; it does not convert ACP to Serve. Other configuration and the original default backend are preserved; cancellation writes nothing. A normal `config.json` must already exist. The command refuses edits when backend environment overrides would hide their effects. Saving uses a lock and atomic replacement; do not edit the same file concurrently. Restart Live afterward.

`doctor --peers` checks configuration, terminal directories, connection capabilities, and authorization settings. It does not start a call, send commands, or grant access. An unstarted managed Serve is shown as unverified; diagnostics do not start it or guess its dynamic port. A configured controller does not prove its grant remains valid.

### Discover existing terminals

Discovery requires a `kind: "qwen-code"` backend with `peerDiscovery.qwenHome` matching the target terminal's local Qwen home. Qwen must have `agents.crossSessionMessaging: true`; restart the target terminal after changing it. Omitting `peerDiscovery` disables discovery. ACP entries do not support it.

During a call, `session_list` includes managed sessions and reachable `tui` terminals. Host's **Terminal sessions** section refreshes this list. External execution state remains `unknown`; without a controller grant, terminals are read-only. They are not counted as ordinary Running / Completed tasks.

Directory and socket names are display metadata. Delivery targets use a handle bound to Qwen home, session ID, PID, and start time. A matching name alone does not select a terminal; discovery failure is not task completion.

### Send text to a terminal

Using a Qwen CLI that supports `sessions controllers`, manually create a controller grant in the **same Qwen home**:

```bash
QWEN_HOME="$HOME/.qwen" qwen sessions controllers add --label "Qwen Live Harness" --json
```

Save the returned token through incremental setup, or set `peerDiscovery.controllerTokenEnv` to an environment variable containing it. Choose either `controllerToken` or `controllerTokenEnv`, not both. This token differs from the Serve REST token and must not be passed by voice. An environment-based token must be visible to the process launching Live; double-clicking Host does not automatically inherit terminal variables.

Start a call, list sessions, and ask Live to send a specific instruction to the selected terminal. `handoff` delivers text and returns an independent `delivery_N` receipt. This is not a backend job and does not prove execution, steering into an active turn, or completion. The channel does not accept screenshot attachments, stop terminal jobs, or answer their tool permissions.

The target's `agents.crossSessionInbound` policy still applies: `hold` requires terminal review; `refuse` rejects delivery. Host shows **Instruction deliveries**, and `session_monitor` accepts a `delivery` argument:

- `pending`: write attempted, no receipt yet; `held`: waiting for terminal review.
- `delivered`: entered the inbox, not task completion; it may later become `expired` or `misaddressed`.
- `denied`, `refused`, and `dropped` reflect actual receipts. `unknown` means uncertainty, not permission to resend automatically.

Without a receipt, delivery becomes unknown after 30 seconds by default. Each controller retains at most 100 deliveries, evicting finished tracking entries first and rejecting new sends if all entries are still tracked. End call stops tracking but cannot retract an instruction already written. Qwen owns grant management, revocation, and terminal review.

Before sending, Live rechecks registration and pins the target socket and full session ID. The protocol has no atomic PID/start-time check; directory metadata is not strong authentication against other programs running as the same user.

### Receive and speak reports

`peerDiscovery.reports: true` separately enables reports; the default is `false`. Receiving reports neither requires a controller grant nor makes terminals controllable. Each call publishes a temporary Live peer address; handoff includes the address and a reporting example when applicable.

The target session must provide the public `send_message` tool, share the Qwen home, and permit that tool call. Live does not grant this permission. Managed sessions can also use the public tool. An adapter without its own report endpoint gets reporting instructions only when exactly one report provider is available.

Reports can be `progress`, `blocked`, `result`, or `info`; plain text is received as `info`. Host's **Session reports** shows source, body, and queued/submitted/spoken status. `session_monitor` can query them with `reports: true`. Ambiguous sources are marked unconfirmed. Source matching provides attribution, not strong authentication against arbitrary same-user programs.

Report speech waits for user speech, foreground responses, and device playback to finish, then uses an independent response with no tool permissions. A report is not a new user instruction, permission answer, or verified completion event. Original backend events still announce associated managed-job results to avoid duplicate completion reports. Muted output retains text without speech; interrupted or failed reports are not automatically replayed.

Each report is limited to 2,000 characters. Reception limits are 20 per minute overall and 6 per source socket; attribution and speech queues hold 32 each; display history holds 100. Addresses and associations expire at call end, and old messages are not replayed. Previous-call reports remain visible until the next call starts.

Implementation: [`qwen-peer-discovery.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-discovery.ts), [`qwen-peer-controller.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-controller.ts), [`qwen-peer-reports.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/adaptor/qwen-peer-reports.ts), and [`session-reports.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/orchestrator/session-reports.ts). The peer SDK vendors pinned [official Node-only source](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/vendor/qwen-code-peer/README.md) with provenance checks. Peer transport supports macOS/Linux; full desktop interaction still requires macOS. The terminal protocol test baseline is Qwen Code 0.23.3, not a promise that arbitrary older versions support it. See the [M3 acceptance checklist](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/docs/m3-acceptance.md) for integration verification.

## Protocols and capability boundaries

### Model tools and MCP

Main Omni uses daemon-defined tools for Appshot, Memory, Proactive, and delegation. It does not directly receive every backend tool.

This package has no independent MCP configuration or management layer. Configure MCP in the background Harness; availability inside ACP sessions depends on that backend. ACP session creation/loading currently sends `mcpServers: []`. Adding MCP support requires a real execution and permission channel, not only new Realtime tool instructions.

The main assistant identifies as **Qwen Omni** in both backend and no-backend modes. It answers self-contained conversation directly and prefers `web_search` for simple public-information lookups. Files, commands, complex execution, and work explicitly assigned to an agent use the Harness.

`web_search` is available with or without a backend and has no local model-name allowlist. Its independent text-only Realtime connection reuses the main model ID, including aliases, endpoint, and API key exactly. There is no separate search model configuration; native search support is determined by the service. See [`src/realtime/web-search.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/realtime/web-search.ts).

The tool immediately returns `accepted + taskId`; searches execute independently and can run concurrently, each with a 25-second timeout. Only the query is sent, not microphone audio, screenshots, Memory, or other work-session context. Search usage comes from service metadata; an unknown search status must not be presented as verified browsing.

Results enter the Injector's `search_result` channel and wait for speech, foreground responses, and playback to finish. Main Omni composes the answer from query/answer/searchStatus rather than reading the raw result verbatim. The result creates no user message and has no tool permissions, so webpage text cannot trigger another search, delegation, or Memory mutation. Search tasks have `kind: "search"`, support independent cancellation, and distinguish waiting for delivery from completed delivery.

If native search fails and a backend is configured, runtime creates an isolated default-backend session using only the original query plus read-only public-information constraints. It reuses existing handoff, task records, and permission handling. Failed output and webpage instructions do not become authorization, and the main model does not duplicate the fallback. Without a backend, failure is reported. The search record tracks failure/fallback, and the backend job follows real events. End call or a new conversation cancels unfinished searches, withdraws pending results, and stops that call's automatic fallback queries; unrelated jobs keep their normal lifecycle. Requesting cancellation is distinct from backend confirmation.

### Audio and visual input

The main session requests `semantic_vad`, `create_response: false`, and `interrupt_response: true`: the service detects turns, while the daemon schedules `response.create`. Memory updates and tool continuation must not switch the main VAD mode. Independent monitors manually commit media chunks; search is text-only. Their `turn_detection: null` does not disable VAD in the main conversation.

Transport uses mono PCM16: 16 kHz input and 24 kHz model output. Host resamples output to the device's actual rate; do not force the system output clock to match the model.

There is one selected visual source and capture mode:

| Path                     | Content and scope                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Live Feed                | Continuous frames from the selected camera or full selected display to main Omni                                                 |
| On Demand Appshot        | Source metadata, available accessibility text, and a snapshot asset handle; Screen captures the foreground window                |
| Proactive visual monitor | Selected camera or full-display frames to an independent Monitor, including independent sampling in On Demand mode               |
| Optional visual Memory   | Reuses Live Feed frames or privately captures the foreground window/camera in On Demand mode; stores processed text observations |

Appshot returns an image asset through `function_call_output`; it **does not append pixels directly to main Realtime** or commit audio. Pixel-level analysis requires an image-capable backend. Without one, suggest Live Feed. An asset handle is not evidence that the model has seen the image.

Protocol types and limits are defined in [`host/types.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/host/types.ts), [`realtime-session.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/realtime/realtime-session.ts), and Host's shared protocol. Current Host protocol is v9:

- Input/output is bound to a call epoch, and output also to `outputId`. Preserve these identities through playback start, completion, and clearing; stale acknowledgements must not advance a new turn.
- Capabilities negotiate extensions such as display capture and audio-end markers. An end-marker-capable Host acknowledges completion only after processing that output's marker and all queued audio.
- Proactive notifications play FIFO after foreground responses and device output finish. Capture and event queueing continue. Updating or cancelling a task withdraws its old events.
- Full-display coverage does not imply native resolution. Live frames and snapshot assets have different size/transport limits. Discard late results after source, display, or epoch changes.

### Logs and shared text

Use `--debug` to correlate Host connections, epochs, capture dimensions, frame hashes, tool results, and playback timing. Session JSONL, Memory databases, and diagnostic files serve different purposes and may contain user conversations and task content.

Audio, visual, and combined Monitor debug archives include actual requests and original images/audio. Only the latest ten Monitor directories are retained; this is not a fixed disk quota. See [Monitor diagnostic archives](#monitor-diagnostic-archives) and inspect sensitive content before sharing.

All fixed UI/init text lives in [`src/i18n/messages.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/i18n/messages.ts), with paired `en` / `zh-CN` entries and matching placeholders. Host reuses it at build time. System prompts and raw backend output are not UI translation-table entries.

## Advanced configuration

This section is for developers changing adapters, scheduling, or memory behavior. User editing steps and common examples are in [Configuration and features](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/docs/configuration.md). Validation in [`config.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/config.ts) and [`memory/config.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/memory/config.ts) is authoritative; users do not need to write every default to their configuration.

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

Set `token` if authentication is required. `baseUrl` is an alternative to `serveUrl`. These entries do not use ACP process fields. Omitting `backends` preserves the legacy local `qwen serve` connection behavior; use `[]` to disable backends explicitly.

### ACP permission modes

An ACP backend's optional `sessionMode` must **exactly match** an `id` in the backend's `session/new` `availableModes`. This is backend-defined, not a universal “skip approval” switch, and does not apply to `kind: "qwen-code"` Serve entries.

If omitted or unmatched, Live tries an asking mode exposed by the backend: first `default`, then a `read-only` mode named `Ask for approval`. A missing requested ID produces a warning. If no asking mode matches, or `setSessionMode` fails, the backend keeps its own mode. Per-operation manual approval is therefore **not guaranteed**.

Actual permission scope comes from the backend. Check its documentation and final state. The current success log labels any explicit `sessionMode` as not requiring per-operation approval; do not infer permission scope from that wording. Selecting `default` does not itself imply unrestricted access. Tests in this area should cover valid/invalid IDs, missing modes, switch failures, and permission forwarding.

### Spoken permissions and persistent approval

Main Omni generates permission questions in the current real conversation's language, falling back to `config.language` only when conversation language cannot be determined. English backend titles, commands, and paths are approval data, not language instructions or user consent. The independent permission response cannot call tools or substitute a progress announcement for a question. A later explicit user answer is handled by ordinary conversation through `respond_permission`. The original action remains visible in subagent details.

Completion/failure notifications use an independent `task_result` response. Runtime supplies the real status, task, and summary; the model briefly explains them in the current conversation's language rather than using a fixed English template. It must not read internal IDs, raw paths, or Markdown aloud or call tools through the notification. Recent real-user language samples can persist across calls only for language selection, not as result facts. Without a sample, trusted response instructions explicitly specify the configured language.

After an actual permission request, ordinary `allow` approves only that request. Use `allow_always` only when the user explicitly asks for ongoing permission. This applies to ACP and Qwen Serve backends with permission forwarding.

`allow_always` prefers persistent options offered and stored by the backend, such as all file edits or this command within this project. When several exist, the first is used; Qwen project-scoped options precede user-scoped options. This is not unconditional permission for all operations.

If the backend offers no persistent option, or hides it for the current request, Live falls back to one-time approval rather than denial. Only in this case does Live also retain a **30-minute, same-action-only** local rule for the current session. Similar but different actions are not covered.

A later explicit `deny` removes the matching local Live rule, not permissions already persisted by the backend. Revoke those in the backend; they are not limited by Live's 30-minute rule.

### Proactive tuning

The scheduler supplies fixed chunks of new media to an independent Monitor. Capture, inference, and foreground delivery are separate stages. Higher FPS or shorter intervals do not guarantee proportionally faster triggers; capture, network, and audio queues also matter.

| Field under `proactive`                | Default    | Meaning                                                                                                               |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `enabled`                              | `true`     | Enable monitoring and tools                                                                                           |
| `monitor.chunkDurationSec`             | `1`        | Seconds per user media chunk; range `0.1`–`60`, independent of scheduler interval                                     |
| `monitor.sessionRecycleEvals`          | `60`       | Rebuild a Monitor connection after this many evaluations                                                              |
| `monitor.representationCompact`        | `"normal"` | Visual representation aggregation: `normal` or `none`; unused for audio-only monitors                                 |
| `scheduler.evalIntervalSec`            | `1`        | Seconds between checks for the next evaluation                                                                        |
| `scheduler.maxFailuresPerTask`         | `3`        | Consecutive failures before stopping a task                                                                           |
| `scheduler.repeat.cooldownSec`         | `3`        | Repeat-trigger cooldown, seconds                                                                                      |
| `scheduler.repeat.maxWaitTtsSec`       | `30`       | Playback-completion wait after foreground Realtime creates a notification response; does not limit earlier queue time |
| `scheduler.repeat.clearBufferOnResume` | `true`     | Clear old pending capture on resume                                                                                   |
| `vision.fps`                           | `2`        | Independent target Monitor FPS; limited by capture speed                                                              |
| `vision.windowSizeSec`                 | `10`       | Local new-frame buffer limit, seconds; not history resent every round                                                 |
| `vision.minEvalDurationSec`            | `0`        | Extra observation before the first evaluation; zero still requires a full chunk and at least two valid new frames     |
| `audio.windowSizeSec`                  | `60`       | Local new-audio buffer limit, seconds                                                                                 |
| `audio.minEvalDurationSec`             | `0`        | Audio observation before the first evaluation                                                                         |

Minimum observation duration cannot exceed the corresponding window. `vision.fps` ranges from `0.1` to `60`, with `vision.fps × monitor.chunkDurationSec ≥ 2`. Both windows must be at least the chunk duration. Invalid configurations fail explicitly at startup rather than creating tasks that can never collect a complete chunk. Device speed is not guaranteed. Foreground `visualInput.fps` is independent. Long capture gaps reset continuous observation duration, and old frames do not count as fresh evidence.

Monitor uses an interleaved session: one `session.update` sets system instructions, `turn_detection: null`, `smooth_output: false`, and empty tools, followed by a user text describing the task. Each round sends one new media chunk, waits for acknowledgement of `input_audio_buffer.commit`, sends `response.create`, then waits for `response.done` before the next chunk. The service retains previous user media and assistant replies; the client does not repeatedly reconstruct history.

Default audio-only chunks are one second of mono PCM16 at 16 kHz, without extra silence. Video-only chunks pair two images with a one-second `protocol_silence` track to carry the audio-buffer commit. Mixed chunks use one second of real audio and two frames from the same time span. Missing images are not replaced with old ones; incomplete mixed chunks log their drop reason. Less than 2 FPS is unsuitable for default one-second mixed chunks.

During slow inference, new media stays in bounded local queues rather than entering the server's in-flight buffer or being combined into a multi-second evaluation. Rebuilding a connection loses that transport's model history. Only unconsumed new media is retained; previously evaluated sounds or images are not replayed. Use `transportGeneration` to identify history boundaries.

`monitor.representationCompact` maps to `session.video.input.representation_compact` in the initial session update, before any audio, including protocol silence. It does not change within a connection and remains configured after recycle/recovery. Restart after editing; `none` is useful for fine visual detail.

The legacy `scheduler.maxConcurrentTasks` field can still be read but no longer limits task count; omit it in new configurations. Monitor judgments and notifications remain subject to sampling, network, and delivery delays.

### Memory model connections

The updater consolidates long- and short-term information from conversations; it does not produce environment-observation records. A separate, optional observer creates environment memories from visual input. Disabling the updater does not delete environment memories, and its output schema is independent of observer capture and environment retrieval.

Updater and observer use same-region `/compatible-mode/v1/chat/completions` derived from the Realtime endpoint by default; vector retrieval uses `/compatible-mode/v1/embeddings`. The updater defaults to `qwen3.7-plus`; an omitted `observer.model` inherits it. Visual observation requires image support.

`updater.baseUrl` / `observer.baseUrl` override the respective HTTP(S) compatible API base URL, without a `/chat/completions` suffix. `apiKeyEnv` names a credential environment variable and requires its corresponding `baseUrl`. Overriding the base URL with an empty `apiKeyEnv` still reuses the main API key, so verify the destination's trust boundary. Embeddings always use the main DashScope connection.

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
| `retrieve.maxChars`                       | `5000`                | Raw result text budget                                                                           |
| `retrieve.retrievedMaxChars`              | `6000`                | Retrieved section budget after rendering into context                                            |
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
| `retrieve.rrfK`                           | `60`                  | Rank-fusion parameter                                                                            |
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

`retrieve.maxChars` cannot exceed `retrievedMaxChars`; `backfillTimeoutMs` cannot be shorter than `timeoutMs`; `segment.minTurnsBeforeGapCut` cannot exceed `maxTurns`. See [Memory configuration validation](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/memory/config.ts) for complete ranges.

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

Legacy configuration without `backends` also supports `serveUrl` / `serveToken` and `QWEN_LIVE_HARNESS_SERVE_URL` / `QWEN_SERVER_TOKEN`. Prefer explicit backend arrays in new configurations.

Installed desktop registration records absolute Node/CLI paths, PATH, configuration/discovery directories, and working directory, not arbitrary shell environment variables. Prefer the configuration file for settings needed when double-clicking Host; a variable present in one terminal may not exist in desktop startup.

`DATA_DIR` moves configuration and default data, **not** the discovery base, which remains `~/.qwen-live-harness` unless overridden. For example, an installed CLI can use an isolated configuration:

```sh
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-work"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
qwen-live-harness init
qwen-live-harness
```

For source development, replace the final two commands with `npm run init` and `npm start`. `DATA_DIR` is environment-only; there is no `dataDir` configuration field. `discoveryDir` can be configured and overridden by `QWEN_LIVE_HARNESS_DISCOVERY_DIR`. A manually connected Host uses `QWEN_LIVE_HARNESS_DISCOVERY_FILE` with the complete discovery-file path.

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
- JPEGs are frames successfully written to the model connection. `input.wav` contains mono 16 kHz PCM16 successfully sent before that commit and not discarded by `input_audio_buffer.clear`, concatenated in send order, including protocol silence. It is not an uninterrupted microphone recording. Audio offsets exclude the WAV header.
- Audio events in `request.json.events` have `origin`: `microphone`, `protocol_silence` for a video-only carrier track, or `unknown`. `audioSummary` lists `totalBytes`, `microphoneBytes`, `protocolSilenceBytes`, and `unknownBytes`. These archive-only fields are not sent to the model and do not classify energy or events. Media buffered during a handshake or slow inference may be sent later; send time is not capture time.
- `request.json` records initialization settings, task text, event order, frame hashes, audio offsets, and `previousRequest`. `transportGeneration` identifies connection history boundaries. `previousRequest` links only within a transport and resets after reconnection. Server context can retain earlier committed media and replies; a single WAV is not the entire context visible to the model.
- `request.json.session` is an initialization snapshot included for standalone inspection, **not a replay of system instructions or task text each round**. Event IDs in that snapshot stay the same within a transport. Actual incremental sends are in `events`, normally media append, commit, and `response.create`. Only a new transport resends initialization.
- Valid `providerSessionId` values are recorded when available. `response.json` contains raw action text and parsed results, plus `responseId`, `eventId`, and `usage` when provided. Request events preserve available send IDs. Do not infer missing identifiers; usage is not equivalent to useful microphone duration.
- Correlate Host, daemon, and `proactive.monitor_image_sent` frame hashes. `proactive.monitor_commit` counts successful socket writes; `proactive.monitor_committed` records service acknowledgement. Queued or dropped frames are not evidence of delivery.
- `proactive.monitor_chunk_prepared` records capture ranges and actual frame counts. `proactive.monitor_chunk_dropped` records missing images, capture gaps, invalidated pending chunks, or uncertain commit sends. `proactive.monitor_input_dropped` aggregates local eviction counts, bytes, and time ranges. These debug session events distinguish missing complete input from a model `wait` decision.
- Retention is the **10 newest Monitor directories across all modalities**, not 10 per modality, 10 requests, or a total disk quota. Evicted monitors continue running without further archival. Directories/files use private permissions; pending and queued writes have a 32 MiB memory budget. Disk faults or budget limits can make archives incomplete but must not end a call.
- JSON redacts connection credential fields and known API keys, not every secret spoken, shown, or written by the user. Inspect WAV, JPEG, and JSON before sharing, not just terminal output. Do not share the whole data directory.

#### Scheduler decisions and session JSONL

Media archives show only input actually sent to an inference. Audio dropped during cooldown is not in WAV files. Debug mode also prints key Proactive metadata and stores it in session JSONL under `<dataDir>/sessions/`. Records have `type: "proactive.debug"` and the concrete event name in `payload.event`:

- `proactive.monitor_commit`, `proactive.monitor_committed`, and `proactive.monitor_result`: submission, service acknowledgement, and inference result.
- `proactive.evaluation_decision`, such as `notification_accepted`, `suppressed_awaiting_false`, `rearmed_false`, or `ignored_cooldown`: separates a model trigger from permission to deliver a notification.
- `proactive.cooldown_started`, `proactive.cooldown_resumed`, `proactive.cooldown_audio_dropped`, and `proactive.buffer_reset`: cooldown, dropped-audio statistics, and pending-buffer cleanup, not separate recordings of discarded audio.

First match `taskId` and task generation (`taskGeneration` for Monitor events; `generation` for some scheduler events), then correlate nearby results by `evaluation`, `transportGeneration`, and available `providerSessionId` / `responseId`. Not every event has every identifier; timestamps alone can mix tasks or connections. JSONL holds bounded diagnostic metadata, not per-frame media or input from before debug was enabled.

See [`monitor-debug-store.ts`](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness/src/proactive/monitor-debug-store.ts). For Host-private failure logs and device diagnostics, see [Logs and shared text](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md#logs-and-shared-text).

## Packaging and releases

The root workspace is private; this directory publishes the `qwen-live-harness` npm package. Its tarball contains built `dist` and licensing, not Electron Host. `npm run check:package` verifies that boundary.

Public npm and signed Host releases must match versions and protocol. The [Host development guide](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/packages/qwen-live-harness-host/README.md#release-maintenance) covers building, signing, notarization, GitHub Releases, OSS, and npm publication. Everyday source debugging does not require publishing or changing installer trust rules.

License: [Apache License 2.0](https://github.com/QwenLM/Qwen-Live-Harness/blob/main/LICENSE).
