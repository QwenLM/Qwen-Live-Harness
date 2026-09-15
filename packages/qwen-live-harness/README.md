# qwen-live-harness

Qwen Live Harness is a standalone realtime voice daemon that orchestrates
coding sessions through voice.

`qwen-live-harness` connects three parties:

- **Qwen Live Harness Host** (the macOS overlay app) over the Qwen Live Harness Host WebSocket
  protocol v9 — writes `~/.qwen-live-harness/run/daemon.json` for discovery, so an
  already-installed Host connects automatically.
- **A DashScope realtime voice model** (`qwen-omni` realtime) that owns the
  conversation: VAD, direct answers, and a tool surface for dispatching work
  to coding sessions.
- **Coding sessions** through a `BackendAdaptor`. Two adaptors are available:
  one drives `qwen serve` over REST/SSE, and one spawns any ACP-compatible
  agent (`qwen --acp`, `qodercli --acp`, `gemini --acp`, etc.) as a child
  process over JSON-RPC stdio. Multiple backends can coexist with per-session
  routing.

The live session itself is fully owned by this daemon (JSONL logs under
`~/.qwen-live-harness/sessions/`); backend sessions are ordinary coding sessions
that keep running after a call ends.

Memory is enabled by default. Local libraries under `~/.qwen-live-harness/memories/`
retain dialogue, selected user facts and optional visual observations across
calls. The orb's Settings → Memory section controls the feature, selected library, names and
consolidation model. See [Memory configuration and behavior](#memory).

## Quick Start

### 1. Install

Qwen Live Harness requires Node.js 22.13 or newer for built-in SQLite/FTS5 support.

```bash
# From the standalone repository
git clone git@github.com:QwenLM/Qwen-Live-Harness.git
cd Qwen-Live-Harness
npm ci && npm run build
```

### 2. Run the setup wizard

```bash
npm run init
```

The wizard will:

- First let you choose **简体中文 / English** with the **Left / Right** arrow
  keys and Enter. All following questions and fixed setup messages use that
  language; a fresh setup initially selects Simplified Chinese.
- Scan your PATH for installed coding agents (qodercli, qwen, gemini,
  claude, codex) and list what it found
- Let you pick a default backend and add additional ones
- Ask for your DashScope realtime API key
- Let you select the DashScope Realtime API name (the default is
  `qwen3.5-omni-plus-realtime`)
- Ask whether to enable Memory (default: yes), then ask for the DashScope
  consolidation model when enabled (default: `qwen3.7-plus`)
- Set a default working directory for coding sessions
- On macOS: check if the Qwen Live Harness Host app is installed and offer to install it
- Register the current Node/CLI runtime so the installed Host can start it

When done, it writes `~/.qwen-live-harness/config.json` and desktop startup
registration, without starting the Host, daemon or a call. From a source
checkout, continue with `npm start`. For a globally installed package, the
equivalent commands are `qwen-live-harness init` and `qwen-live-harness`; both the
npm package and executable are named `qwen-live-harness`, with no npm scope.
Before the matching signed Host is published, skip the wizard's optional Host
download and run the source-built Host described below.

The new identities do not read the previous installation's configuration, Memory,
discovery, Host preferences or environment-variable names. Run the wizard again
and update shell overrides to `QWEN_LIVE_HARNESS_*`. Existing apps and user data
are left untouched; there is no automatic migration or old-name fallback. See
[migration details](../../docs/migration.md).

### 3. Start the application

```bash
npm start
# Or, with the global CLI: qwen-live-harness
```

The CLI starts or reuses a daemon and opens the installed macOS Host. After
setup, opening **Qwen Live Harness Host** from Applications or Launchpad works
as well: it connects to an existing daemon or launches the registered one.
Repeated CLI or desktop launches reuse the running application. Existing users
with a valid config can run the CLI once to refresh desktop startup registration
without overwriting their configuration.

The Host does not contain Node or the daemon package. A Host downloaded on its
own asks you to install the CLI and complete `qwen-live-harness init` first.
If Node or the CLI moves, run the CLI from its new installation to refresh the
registration. The desktop launcher uses the recorded absolute Node/entry paths
and PATH, so it does not depend on Finder loading your shell startup files.
See [Desktop startup](#desktop-startup) for diagnostics and custom directories.

For source Host development, use the internal daemon-only mode in one terminal
and build/run the Host in a second terminal from the repository root:

```bash
# Terminal 1
npm start -- --daemon-only --debug

# Terminal 2
npm ci --prefix packages/qwen-live-harness-host
npm run build:host
npm --prefix packages/qwen-live-harness-host start
```

Quit the previous daemon and Host first. On macOS, the Qwen Live Harness Host
reads the new discovery file and connects
automatically. Once the Host connection, selected-source permissions and
self-checks are ready, a newly launched Host starts one call automatically.
An existing call or an explicit start/stop/new/quit consumes that startup
intention; reconnects, renderer reloads and failed starts never loop into a
new call. Press `Command+E` to start or end a call manually (an explicitly
configured shortcut still takes precedence).

### Desktop startup

Initialization atomically saves configuration before writing a private runtime
registration at `~/.qwen-live-harness/run/runtime.json`. Ordinary CLI startup
refreshes it as well. Registration stores the Node executable, CLI entry point,
version, working directory, data/discovery directories and PATH. It does not
copy API keys or arbitrary environment variables. Use config for settings that
must also work when launching from the desktop.

`QWEN_LIVE_HARNESS_DATA_DIR` selects the config/data directory.
`QWEN_LIVE_HARNESS_DISCOVERY_DIR` selects the discovery base independently;
runtime registration and discovery are under its `run/` directory. For a
separately launched Host using a custom discovery base, set its
`QWEN_LIVE_HARNESS_DISCOVERY_FILE` to the full `run/daemon.json` path. The default
discovery base remains `~/.qwen-live-harness` even when the data directory changes.

Host-initiated startup writes bounded diagnostics under the discovery base's
`run/logs/` directory, keeping the latest five `daemon-startup-*.log` files with
at most 1 MiB per file. Missing configuration, invalid runtime paths, version
incompatibility and failed startups are surfaced to the user. An initial launch
can start a missing daemon once; a subsequent disconnect does not cause an
automatic restart loop. `End call` ends the interaction while leaving the app
available. `Quit Host` requests coordinated shutdown of the daemon and Host.

The internal `--daemon-only` CLI option runs just the daemon for debugging and
tests. Host uses this mode when bootstrapping, preventing recursive Host launches.

The setup panel and orb first appear at the bottom-right. Drag the setup
header or orb to move them; Host remembers the shared position across restarts
and clamps it to a visible display if monitors change. Hover the orb to reveal
microphone, voice output, Start/End call, Settings and Quit controls. They fade
one second after the pointer leaves, unless settings or keyboard focus need
them. Ending a call leaves a gray orb in place; it does not quit the app.

Settings presents Audio Source, Video Source and Capture Mode as peer groups,
followed by Memory. The selected mode shows its own explanation. It preserves focus,
drafts and camera preview while state changes, and closes on Escape or outside
interaction. Setup asks only for the selected source's permissions, so Camera
does not require screen recording or accessibility permission. The orb uses
compact visible bounds when dragged to an edge; opening Settings temporarily
fits the whole panel on screen, without replacing the saved resting position.
Camera selection shows a nearby preview by default. Its floating eye button
only hides/shows the preview; it does not stop camera input or frame delivery.
Selecting Screen or quitting retains the existing camera shutdown behavior.

**Open config.json ↗** at the top of Settings opens the connected standalone
daemon's actual configuration in the OS-associated JSON editor or IDE. This
respects the daemon's `QWEN_LIVE_HARNESS_DATA_DIR`, even when Host starts separately.
Save the file and restart Qwen Live Harness to apply manual edits. Older daemons and
built-in `qwen serve` do not advertise this action. Missing, non-regular (including
symlink) files or editor failures show an error; the action never creates or
overwrites configuration.

**Language** is followed by Theme at the end of Settings. It switches the fixed Live interface
between English and Simplified Chinese and saves the selection in the top-level
`language` config field (`"en"` or `"zh-CN"`). Existing configs without the field
remain English. Language changes apply during a call without restarting media;
model prompts, responses, transcripts and user/device/library names are not
translated. A connected standalone daemon owns the saved preference. With a
legacy Host connection, the selection is saved only in Host's local preference.

Drag the Settings title bar to move the panel; it shares the orb's remembered
position. Opening Settings first fits the whole panel into the display work
area and waits for native positioning before showing it. Microphone animation
now amplifies small input peaks visually, with a bounded envelope and smooth
release; it does not change the recorded audio gain.

All fixed Live display translations are maintained as paired `en` / `zh-CN`
entries in [`src/i18n/messages.ts`](src/i18n/messages.ts). Edit both values there,
preserve matching `{placeholders}`, then rebuild Live and Host. Host compiles
this same public, browser-safe module into its bundle; no second dictionary or
runtime language-pack installation is needed. Technical diagnostics and raw
external error details retain their original language.

`Quit Host` gracefully shuts down the connected standalone Live daemon and
Host, including owned ACP processes, Memory work and discovery. It does not
terminate an independently running `qwen serve`. A legacy WebShell connection
only ends its Live call and closes Host. If shutdown is not confirmed, the
orb remains with an error and Quit can retry the same authenticated instance.
It never redirects a retry to a different discovered daemon.
Same-instance reconnects retain the authenticated shutdown target, independently
of the WebSocket. Quit always attempts the authenticated shutdown request. It
completes only with a matching receipt, or after a refused connection plus an OS
probe proves the original daemon PID no longer exists; a PID probe alone, HTTP
errors, resets and timeouts do not prove shutdown. Failed Quit keeps media stopped.
On cleanup failure the daemon retains only its authenticated shutdown control
endpoint and discovery, rejecting new work. A retry closes only the resources
that previously failed; successful cleanup steps are not repeated. Cleanup logs
identify the failed resource and bounded, credential-redacted causes. Signal-driven
process exit instead releases only its own discovery record even if cleanup fails;
it never removes a replacement daemon's record.

On other platforms: the Qwen Live Harness Host app is macOS-only (it needs native
microphone, global shortcut, and screen capture). Linux/Windows users cannot
use voice features until a Host is available on their platform.

## Subagents

Hover or keyboard-focus the orb to reveal a side summary explicitly labelled
**Subagents** / **子智能体**. Click it for a compact list, then select a task for
details within that same frameless panel, with **Back** to the list. The view covers
Proactive monitors/reminders and tasks delegated by Live to a coding harness.
It shows the original request, actual status, latest activity, public
intermediate text, available plan/tool updates and final result. It does not
invent a completion percentage or expose thought chunks/raw tool payloads.

The compact summary shows dot/running and check/completed counts. The running
dot gently pulses only while connected with active tasks, and stays static with
system reduced motion. A waiting marker appears only when input is needed;
tooltips and accessible labels retain exact counts, including when large counts
are displayed as `999+`.

`Running` counts active tasks, including queued and waiting tasks. `Completed`
counts successful outcomes plus cancelled Proactive monitors, whose details
still say Cancelled. Cancelled timers/harness jobs, failed and interrupted
tasks remain distinct. `Needs you` only counts tasks waiting for user input or
approval, not failures or interrupted tasks. Monitor evaluations and repeat notifications do not
create extra tasks, and an instruction joined to a running job does not count
twice. Monitor notification delivery is shown separately from task completion.

Ending the voice call stops Proactive sampling and retains its terminal
records. Harness tasks keep running and updating this view without reopening
audio or the realtime model. Permission requests received while no voice call
is active remain pending and can be answered from the task details. The panel
shows only real backend requests and the scope of each offered Allow / Deny
choice; it never bypasses a sandbox or invents an approval for an ordinary
filesystem error. Requests without a confirmed task identity appear separately.
Their pending count also activates the summary's attention marker. Overlong
requests require review in the backend before approval; Live still offers Deny
when the backend supports it.
For supported Codex ACP sessions, Live selects the advertised **Ask for approval**
mode before sending work. Unsupported or failed mode selection is logged rather
than silently claiming manual approval is available. Existing backend sessions
and global permission settings are not changed.

Use **Stop** on a task row or in its details to stop that exact Harness task or
monitor. A pending cancellation says **Stopping…** until confirmed; an unknown
task identity or unsupported backend cannot fall back to stopping a different
task in the same session. Stop requests and confirmed outcomes are sent to Omni
as silent text context, queued while it is busy and retained across End call for
the next call in the same daemon run. **Close** only dismisses the panel.

Live imposes no active Harness/monitor count limit. Independent Harness work
uses separate sessions; adding instructions to an existing session retains its
steering/queue semantics. Backend quotas, per-session queue bounds and available
machine/API resources still apply.

The orb is never resized or moved to fit task windows. The side summary has a
roughly one-second hover grace period. Expanded lists and details stay open until
Close or Escape, including through blur, Settings, orb dragging and disconnection.
Only the collapsed summary hides during dragging; a subsequent hover reanchors
it inside the new display work area. Drag either expanded header to move the
panel; Back preserves its location, clamping the new size to the display.
Task updates do not move windows or task rows, and output follows the tail only
when you were already at the bottom. Closing the panel does not stop its task.

The final Host Settings option, **Theme**, follows **Language** and offers
System (default), Light mode and Dark mode. This Host-local preference applies
to all its surfaces without restarting media or changing daemon settings.

History belongs to the current daemon run, not a cross-restart task archive.
All active tasks retain bounded details, alongside the latest 32 ended tasks.
Previous / Next pages contain at most 32 tasks and 240 KiB per snapshot; selected
details are fetched separately. Omitted records/truncated output are labelled,
and totals still include omitted tasks. Original backend text may contain
sensitive work content, so the view is
local and only the authenticated Host receives it. New task updates are
capability-negotiated; older Hosts/daemons keep their existing behavior.

## Configuration

Configuration comes from `~/.qwen-live-harness/config.json` (generated by `init`),
with environment variables (`DASHSCOPE_API_KEY`, `QWEN_LIVE_HARNESS_*`) as overrides.

```jsonc
{
  "language": "en",
  "realtimeApiKey": "sk-...",
  "realtimeModel": "qwen3.5-omni-plus-realtime",
  "memory": {
    "enabled": true,
    "dir": "",
    "defaultId": "default",
    "updater": { "model": "qwen3.7-plus" },
    "observer": { "enabled": false },
  },
  "visualInput": {
    "source": "screen",
    "screenDisplayId": "primary",
    "mode": "on-demand",
    "fps": 1,
    "cameraResolution": { "width": 1280, "height": 720 },
    "cameraSnapshotResolution": "native",
    "liveResolution": { "width": 1280, "height": 720 },
    "snapshotResolution": "native",
  },
  "proactive": {
    "enabled": true,
    "monitor": {
      "sessionRecycleEvals": 60,
    },
    "scheduler": {
      "evalIntervalSec": 2,
      "maxFailuresPerTask": 3,
      "repeat": {
        "cooldownSec": 3,
        "maxWaitTtsSec": 30,
        "clearBufferOnResume": true,
      },
    },
    "vision": {
      "fps": 1,
      "windowSizeSec": 10,
      "minEvalDurationSec": 0,
    },
    "audio": {
      "windowSizeSec": 60,
      "minEvalDurationSec": 0,
    },
  },
  "defaultCwd": "~/work/my-project",
  "backends": [
    {
      "name": "qodercli",
      "kind": "acp",
      "command": "/usr/local/bin/qodercli",
      "args": ["--acp"],
      "default": true,
    },
    {
      "name": "qwen",
      "kind": "acp",
      "command": "/usr/bin/qwen",
      "args": ["--acp"],
    },
  ],
}
```

See `src/config.ts` for the full list of options and validation rules.
Visual input has two independent settings. `source` is `screen` or `camera`;
`mode` is `on-demand` or `live-feed`. The defaults are Screen + On Demand,
1 FPS, a 1280×720 camera stream, 1280×720 Live Feed frames, and
native-resolution On Demand Screen and Camera assets. `cameraResolution`
controls the camera preview/Live Feed stream; `cameraSnapshotResolution`
independently controls Camera Appshot assets (`native` or a width/height pair).
`snapshotResolution` controls Screen snapshots. For example,
`"cameraSnapshotResolution": { "width": 1920, "height": 1080 }` requests an
asset fitted within that size without changing the 720p preview.
`qwen-live-harness init` writes these defaults without asking extra questions, so they
can be edited directly afterward.

Proactive is enabled by default. It adds condition monitors, live narration,
and device-time reminders. Each perception task uses an independent,
text-only DashScope Realtime connection while reusing the foreground
Realtime endpoint, API key, and model. Monitor sessions send no voice setting
and output text only. Enabling Proactive exposes the tools; observation starts
only after a perception task is created. Triggered announcements wait for
foreground speech and Host playback to finish, then play one at a time in
FIFO order. Repeated monitors and narration continue observing while earlier
events wait or play, so multiple events from the same task can queue. Event
monitors retain their cooldown and false-edge rule for distinct occurrences;
narration retains novelty-sensitive updates. Each playback acknowledgement
retires only its own event. Cancelling or updating a task removes all of its
old queued events. The delivery ACK
timeout starts when foreground Realtime accepts the announcement and emits
`response.created`; this prevents a missing Host playback receipt from
blocking the FIFO forever. There is no Live-level monitor admission cap;
legacy `maxConcurrentTasks` settings are accepted but no longer enforced or
written by init. Vision and audio retain their own
`windowSizeSec` and `minEvalDurationSec`, including in a combined monitor and
after a Monitor connection is recycled. Task-list replies include remaining
timer duration, reminder content, monitor condition/focus, repeat state, and
the number of pending notifications. A user request may chain Proactive
tools, such as listing tasks and then cancelling one, without a new utterance.

Positive visual warm-up can use elapsed observation time for successful captures
slower than the requested FPS. A capture gap longer than three nominal frame
intervals (with a one-second tolerance floor) starts a fresh observation period;
old frames cannot warm a new isolated frame. The default zero warm-up still
accepts a single fresh frame.

The environment overrides are `QWEN_LIVE_HARNESS_VISUAL_SOURCE`,
`QWEN_LIVE_HARNESS_VISUAL_MODE`, `QWEN_LIVE_HARNESS_VISUAL_FPS`,
`QWEN_LIVE_HARNESS_CAMERA_RESOLUTION` (for example `1280x720`),
`QWEN_LIVE_HARNESS_CAMERA_SNAPSHOT_RESOLUTION` (`native` or `WIDTHxHEIGHT`),
`QWEN_LIVE_HARNESS_VISUAL_LIVE_RESOLUTION` (for example `1280x720`), and
`QWEN_LIVE_HARNESS_VISUAL_SNAPSHOT_RESOLUTION` (`native` or `WIDTHxHEIGHT`). FPS must
be between 0.1 and 10. Source and Mode can also be changed for the current call
from the Host orb; an orb change does not rewrite the configuration file.
Set `QWEN_LIVE_HARNESS_PROACTIVE_ENABLED=false` (or `0`) to disable Proactive entirely;
`true` and `1` enable it. The remaining Proactive parameters are configured in
`config.json`.

Unrecognized keys inside `visualInput`, `proactive` and `memory` are rejected;
a misspelled camera setting does not silently select the default Screen source.

For runtime diagnostics, start the daemon with:

```bash
qwen-live-harness --debug
```

Debug output goes to foreground stderr and reports Host connection state, call
lifecycle, visual capture/frame acceptance, Proactive evidence gates/evaluations,
notification queue and playback transitions, and harness lifecycle events even
after a call ends. `realtime.protocol` records selected provider event types,
IDs, cancellation metadata and committed-input counts for timing diagnosis.
It does not print API keys, image payloads, raw audio, prompts or transcript contents.
Run the Electron Host separately with `--live-harness-debug`, not `--debug` (Electron
reserves that flag). The Host switch does not enable daemon diagnostics.

For Monitor delivery, match the `frameHash` (first 16 SHA256 hex characters of
JPEG bytes) across Host capture, daemon capture/frame receipt, and
`proactive.monitor_image_sent`. Only successful socket writes increment the
per-commit image/audio counters in `proactive.monitor_commit`; audio totals
include protocol silence. `proactive.monitor_committed` confirms the provider
acknowledgement, and `proactive.monitor_action` classifies `wait`, `reply`,
`function_call` or `invalid` without printing the response text. Native display
and orb-position events are recorded by the Host switch, so capture loss can
be distinguished from geometry changes.

**Visual Monitor recordings:** daemon debug mode (also enabled by
`QWEN_LIVE_HARNESS_LOG_LEVEL=debug`) additionally saves actual Monitor requests under
`<OS temporary directory>/qwen-live-harness-monitor-debug/`. Normal runs and audio-only
Monitors do not record media. Each visual Monitor gets a directory, including
combined audio/visual Monitors; WebSocket recycling stays in the same directory.
`proactive.monitor_debug_started` prints its absolute path. Each inference logs
`proactive.monitor_request_saved` with both Monitor and request directories:

```text
monitor-<creation-time>-<id>/
  monitor.json
  requests/000001/
    request.json
    image-0001.jpg
    input.wav
    response.json
```

JPEGs are the exact frames successfully sent to the model. The mono 16 kHz
PCM16 WAV contains the sent audio, including protocol silence. JSON retains
instructions, event order, audio offsets, frame hashes and the reference to the
preceding request in that transport; the response file records returned text,
parsed action or failure. Check preceding requests for the resident conversation
history. Queued/dropped frames are not presented as sent frames.

These are **sensitive recordings of real screen/camera content, task prompts and,
for audio/visual Monitors, microphone audio**. Connection credentials are omitted;
visible or spoken secrets inside media are not redacted. Directories/files are
owner-only. Debug startup and new Monitor creation keep only the ten most
recently created Monitor directories; this is not a ten-request or disk-size
limit. An evicted Monitor keeps running but stops recording and logs skipped
requests. Disk/permission failures or exceeding the 32 MiB pending-write budget
disable that recorder and log an incomplete recording without stopping the call.
Long-running debug Monitors can consume significant disk space; disable debug
after diagnosis and do not share recordings without reviewing their contents.

For `qwen3.5-omni-plus-realtime` and `qwen3.5-omni-flash-realtime`, the initial
session explicitly requests mono PCM input at 16 kHz and output at 24 kHz via
`audio.input.format` / `audio.output.format`, as documented in the
[DashScope session API](https://help.aliyun.com/zh/model-studio/client-events#26a8302028sjm).
Older/custom models retain the legacy PCM fields and 24 kHz playback contract.
Host playback uses a default-device-rate AudioContext, not a forced 24 kHz
hardware clock. With current output-end-marker negotiation, each response is
continuously band-limited/resampled into device-rate buffers and scheduled at
integer sample boundaries, avoiding independent chunk-conversion spikes and
unnecessary gaps. The end marker flushes the short filter tail. Older peers
without end markers retain the legacy Web Audio conversion
and drain behavior. Bluetooth headset microphone activation can
still switch the device into hands-free mode; use a separate/built-in microphone
while keeping headphones as system output when listening to music or video.
Input mute releases capture devices without ending the call; Host's status bar
shows microphone/output mute states beneath the main call status.

### Supported backends

| Backend     | Kind        | ACP entry                                   | Notes                               |
| ----------- | ----------- | ------------------------------------------- | ----------------------------------- |
| Qoder CLI   | `acp`       | `qodercli --acp`                            | Hidden flag; uses Qoder's own login |
| Qwen Code   | `acp`       | `qwen --acp`                                | Native ACP mode                     |
| Gemini CLI  | `acp`       | `gemini --experimental-acp`                 | Official ACP support                |
| Claude Code | `acp`       | `npx @agentclientprotocol/claude-agent-acp` | Adapter-based                       |
| Codex       | `acp`       | `npx @agentclientprotocol/codex-acp`        | Adapter-based                       |
| qwen serve  | `qwen-code` | REST/SSE to `qwen serve` daemon             | Legacy; no ACP needed               |

Multiple backends can coexist — the voice model sees all sessions across
all backends in `session_list` and can route `handoff` to a specific one by
name.

### Terminal session discovery (M3 stage 1)

A `qwen-code` backend can additionally list existing Qwen terminal sessions
from one explicitly configured, local Qwen home. Add `peerDiscovery` to that
backend in `~/.qwen-live-harness/config.json` and restart Live:

```json
{
  "backends": [
    {
      "name": "qwen-code",
      "kind": "qwen-code",
      "default": true,
      "baseUrl": "http://127.0.0.1:4170",
      "peerDiscovery": { "qwenHome": "~/.qwen" }
    }
  ]
}
```

Retain the backend's existing authentication token if required. The Qwen
terminal sessions must use that same home and have
`agents.crossSessionMessaging: true` in their Qwen settings (restart those
sessions after enabling it). Discovery is disabled when `peerDiscovery` is
omitted. This setting applies only to the REST/SSE `qwen-code` backend;
`AcpAdaptor` is unchanged and ACP entries reject this option.

Start a voice call, then ask to list sessions. Existing reachable `tui`
sessions appear alongside daemon sessions with `source: terminal`,
`read_only: true`, and execution state `unknown`. Their peer address includes
an identifying suffix when needed to distinguish equal names. In the Host's
Subagents panel, a separate **Terminal sessions** section shows these entries;
**Refresh** updates the inventory after a terminal starts or exits.
They do not contribute to running/completed task counts.

Without a controller grant, terminal entries remain read-only. Unless reports are
explicitly enabled below, the temporary Live peer refuses incoming application
messages. It closes its socket and registry record when the call ends.
Existing daemon/ACP tasks continue through their normal control and event
paths. A terminal's unknown execution state is never treated as idle or as
proof that its work finished.

### Terminal text instructions (M3 stage 2)

Use a Qwen version exposing `sessions controllers` and the peer protocol (locally
verified with Qwen Code 0.23.3). Create a grant in the **same Qwen home** as the
terminals, using the CLI belonging to that installation:

```bash
QWEN_HOME="$HOME/.qwen" qwen sessions controllers add --label "Qwen Live" --json
```

Copy the returned `token` into the existing backend's `peerDiscovery` object,
then restart Live. Live never creates grants automatically. The controller token
is separate from the REST `token` and must not be supplied in voice prompts:

```json
{
  "qwenHome": "~/.qwen",
  "controllerToken": "qpc_<64 hex characters returned by the CLI>"
}
```

Alternatively, set `controllerTokenEnv` to the name of an environment variable
containing the token. Choose one of these fields; malformed tokens and unset
variables fail configuration validation. A daemon launched from Finder does not
inherit arbitrary shell variables, so use the private config file for that
startup path. Keep its permissions restricted to your user (`chmod 600`).

Start a call, list sessions, and ask Live to send a specific instruction to the
chosen terminal. A configured grant exposes `instruction_only: true` and
`text_instructions: true`; this indicates configuration, not proof the grant is
still valid. Live sends the requested text (plus reporting guidance only when
reports are enabled), rechecks the discovered process
identity, rejects missing/restarted/duplicate targets, and writes to that checked
socket with the complete destination sessionId. Names never select a send target.
The wire pins sessionId but has no atomic PID/start-time check; a process swap
reusing the same sessionId and socket after that check cannot be ruled out by this
protocol. Local registry metadata is not authentication against other programs
running as the same user.

The terminal's `agents.crossSessionInbound` policy still wins: the default allows
a valid controller, `hold` asks for review in the terminal, and `refuse` rejects
the message. List held messages with `/peers` before accepting or denying them.
Controller delivery does not approve the terminal's tool permission requests.

Host shows **Instruction deliveries** separately from tasks, and
`session_monitor` accepts the returned `delivery_N` handle:

| Status                           | Meaning                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| pending                          | The write was attempted; no receipt yet.                                            |
| held                             | The terminal is holding the message for local review.                               |
| delivered                        | The terminal accepted the message into its inbox; no execution or completion proof. |
| denied / refused                 | Local review denied it, or inbound policy refused it.                               |
| expired / misaddressed / dropped | The terminal reported that delivery could not proceed.                              |
| unknown                          | Transport, receipt timeout, or ended tracking left the result uncertain.            |
| failed                           | A transport failure proved the frame was not written.                               |

The receipt timeout is 30 seconds. Late receipts still update records, including
`delivered` changing to `expired` or `misaddressed`. Ending the call stops receipt
tracking; it does not recall instructions already sent. The next call starts a new
delivery history. Each backend retains at most 100 records and Host shows the
latest 100 overall. No automatic resend occurs. In particular, a revoked token may
be silently discarded and time out as **unknown**, not denied or delivered.
Inspect grants with `qwen sessions controllers list --json`; revoke one with
`qwen sessions controllers remove <id>` in the same Qwen home.

Images, terminal cancellation, and permission votes are outside this channel.
Incoming reports require the separate stage 3 opt-in below. These deliveries create no jobs and do
not change running/completed task counts. Ordinary REST/ACP execution is unchanged.

### Session reports (M3 stage 3)

Enable report reception on the same `qwen-code` backend and restart Live:

```json
{
  "peerDiscovery": {
    "qwenHome": "~/.qwen",
    "controllerTokenEnv": "QWEN_LIVE_CONTROLLER_TOKEN",
    "reports": true
  }
}
```

Retain the other backend settings. `reports` defaults to `false`. A controller
grant is needed for outbound terminal instructions; receiving reports does not
require a grant and does not make a terminal controllable. No ACP configuration
or private RPC is added.

During a call, Live publishes a unique public peer address. Each handoff includes
that address and a JSON example for the Qwen session's public `send_message`
tool. The target must share the configured Qwen home, have cross-session messaging
enabled, and expose that tool. Qwen's own `send_message` tool permission still
applies: approve it in the terminal or deliberately configure its allow rule in
that Qwen home. Live does not grant that permission. Managed daemon/ACP sessions
can use the same public tool when available. For an adaptor without its own report endpoint, Live adds
reporting guidance only when exactly one ready report provider is configured.

The public tool arguments are `to` and `message`. The `message` string can contain:

```json
{
  "qwen_live_harness_report": 1,
  "correlation": "<UUID supplied with this handoff>",
  "kind": "progress",
  "text": "The targeted tests passed; checking the remaining integration path."
}
```

Use `progress`, `blocked`, `result`, or `info`. Ordinary text is accepted as an
`info` report. The correlation is optional and is only a filing hint, never
identity or authority. The call's address and correlations expire when the call
ends. A new call receives a different address; old messages are not replayed.
The last call's reports remain visible until the next call starts.

Host's **Session reports** section is independent of tasks and instruction
receipts. A unique current registry/socket match is shown as a registered source;
otherwise it is explicitly unconfirmed. Names and report bodies remain untrusted,
and a match does not authenticate a program running as the same user. A `result`
report is a self-reported result: it does not complete a task, approve a permission,
change a delivery receipt, or authorize any tool call. `session_monitor` with
`reports: true` can retrieve recent reports when the user asks.

Report speech waits for user VAD, pending/direct model responses, and Host audio
playback to finish, including the existing quiet gap. It uses a separate response
with no tool authority; raw report text is not inserted as a user conversation
item or merged into a direct response. The generated assistant announcement is
part of normal provider conversation history. Host distinguishes queue admission,
response submission, actual playback, and completed playback. Muted reports remain
visible without speech; queued reports are discarded from the speech queue on
mute. Interrupted or failed announcements are not automatically replayed.
For a correlated managed-task result, the peer report is display-only and the
normal backend result event retains responsibility for speech. Uncorrelated text
is not deduplicated by similarity, and peer claims never suppress canonical SSE
completion events.

Limits per report endpoint and call:

- At most 2,000 text characters; JSON wire text is capped at 16,384 characters.
- At most 20 reports per minute overall and 6 per sender socket per minute.
- At most 32 reports waiting for source lookup and 32 queued for speech.
- The latest 100 receipt decisions and 100 handoff correlations are retained.
  Duplicate message IDs in the retained window replay the original decision,
  without queueing another report.
- Host retains at most 100 reports overall, preserving pending announcements;
  a bounded page may omit older rows to fit its transport budget.

An incoming `delivered` receipt means Live admitted the report into its bounded
consumer queue or display-only record, not that audio played or work completed.
Invalid reports are `refused`; rate/queue pressure is `dropped`; a wrong destination
session is `misaddressed`. Receipts are best-effort and reports are never resent
automatically. The existing vendored peer SDK is unchanged; Live uses its public
inbox and frame helpers so it can acknowledge **after** consumer admission.

For local protocol validation with an external Qwen CLI, run:

```bash
TEST_CLI_PATH=/absolute/path/to/qwen/cli.js npm run test:backends -- qwen-peer-reports
```

This suite uses isolated homes, a real Qwen TUI and Live daemon, and fake model,
Realtime and Host endpoints. It does not verify physical microphone/speaker
behavior or production provider output. Full device acceptance remains a separate
manual check.

#### Peer transport limits

Only terminal records are added. Registry copies of serve/headless sessions
are left to their existing REST/ACP routes. Names and directories are display
metadata, not authority. A same-id terminal in another runtime is kept separate
from a daemon session; a remote `baseUrl` does not make local discovery remote.
The Node peer transport supports macOS/Linux; Windows peer discovery is not
available. Failure to start discovery is recorded as `peer_discovery` in the
Live log and does not prevent the ordinary voice/backend connection.

The peer module is pinned to the official SDK implementation from
[#11560](https://github.com/QwenLM/qwen-code/pull/11560), with source hashes and
Apache-2.0 provenance. See [the vendor note](src/vendor/qwen-code-peer/README.md).
Builds verify the source offline and the installed package includes only the
required client code, not an embedded backend CLI. The published SDK 0.1.12
continues to supply the HTTP client until a peer-capable SDK release is adopted.

## Memory

If the default Memory HTTP endpoint cannot be derived from `realtimeEndpoint`,
Live logs a warning and keeps daemon setup and local memory available. Model-backed
Memory features without their own valid endpoint stay unavailable; explicit
Memory endpoint settings remain independent. Correct the realtime endpoint and
restart to restore the shared default.

Memory records final dialogue text, lets the foreground model edit working memory with `omnibio`, consolidates selected facts after the call, and retrieves earlier dialogue or visual observations with `omniretrieve`.

### Setup and controls

`qwen-live-harness init` asks whether to enable Memory (yes by default), then asks for the consolidation model (`qwen3.7-plus` by default). Remaining defaults are written without more questions. Existing configurations receive defaults at load time, so reinitialization is optional.

Open **Settings → Memory** on the orb to enable/disable Memory, enable optional **Visual memory**, choose a library, use **New** or **Rename**, and edit the **Consolidation model**. End the call before selecting/creating a library or changing its model. Renaming and switches remain available during calls. New creates and selects a library; OFF preserves the selection and stored data. Accepted changes are merged into the Live config file.

### Storage and lifecycle

By default each library lives in `~/.qwen-live-harness/memories/<id>/` with private `meta.json` and `dialogue.db` files. Its stable id is independent of its display name. `memory.dir` can override the root; relative paths resolve under the Live data directory (`QWEN_LIVE_HARNESS_DATA_DIR`, normally `~/.qwen-live-harness`). Node.js 22.13 or newer is required for SQLite/FTS5. Node versions that label SQLite experimental may print their built-in warning.

Final user transcripts and ordinary assistant replies become searchable segments, including interrupted replies. Synthetic Proactive notices, backend speech, repair turns and tool wrappers are excluded from user dialogue. Memory does not persist raw microphone audio or image frames.

The model selects reusable facts through `omnibio`. Edits to this ordered working-memory list are persisted immediately. At detachment/call end, the consolidation model classifies the final list into a long-term profile and time-sensitive recent items. It does not mine the entire raw transcript. Profile and recent items are frozen per attachment; working memory and retrieved context can change during the call.

Consolidation is serialized per library and deduplicated by session and working-memory version. Shutdown waits `shutdownWaitSec`, then abandons remaining requests. WM snapshots remain on disk, but abandoned jobs are not automatically replayed on restart. Runtime diagnostics report the outcome.

### Retrieval and visual memory

Dialogue retrieval combines Jieba search tokens, SQLite BM25 and optional embedding similarity. A failed or slow embedding request falls back to keyword search. Time ranges reweight candidates rather than excluding every older match; the unsegmented conversation tail can also be searched.

Visual memory defaults off and follows the selected Screen/Camera source. It observes the first available frame, then at the configured interval. Live Feed reuses current frames; On Demand privately captures a bounded frame without requiring a Proactive task or invoking the foreground Appshot tool. Only a cleaned description is persisted. Disabling visual capture preserves access to historical visual observations. Source/attachment changes invalidate late results.

Retrieved content is published through four memory data sections in the model instructions. Tool receipts report only source/counts. The follow-up response receives the newest instructions while persistent session configuration updates wait until the model is idle. Memory text grants no tool authority. Oversized edits are rejected before changing the model's numbered working-memory list.

### DashScope connection

Embeddings use the existing key and regional endpoint's `/compatible-mode/v1/embeddings`. Consolidation and visual observation use `/compatible-mode/v1/chat/completions`, ordinary text/image requests with no Realtime voice setting. The default consolidation model is `qwen3.7-plus`; `observer.model` inherits it unless explicitly set. Embeddings default to `text-embedding-v4`.

`updater.baseUrl` and `observer.baseUrl` optionally select another compatible endpoint; their `apiKeyEnv` names an environment variable, not a secret stored in config. Empty overrides reuse the existing DashScope connection. No private gateway is hardcoded.

Official references checked 2026-09-05:

- [Chat Completions](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- [Embeddings](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)
- [Models](https://help.aliyun.com/zh/model-studio/models)

### Configuration defaults

Place this object under `memory` in `~/.qwen-live-harness/config.json`. The optional Observer model is omitted so it follows the consolidation model.

```json
{
  "enabled": true,
  "dir": "",
  "defaultId": "default",
  "retrieve": {
    "topK": 3,
    "maxChars": 5000,
    "retrievedMaxChars": 6000,
    "useVector": true,
    "model": "text-embedding-v4",
    "timeoutMs": 400,
    "backfillTimeoutMs": 10000,
    "cacheSize": 1000,
    "minSim": 0.4,
    "vecLimit": 50,
    "ftsLimit": 50,
    "ftsAndTryThreshold": 20,
    "andBoost": 1.2,
    "timeRangeBoost": 2,
    "timeEdgeDays": 2,
    "rrfK": 60,
    "envMinGapSec": 600
  },
  "preload": {
    "ltmMaxPerField": 6,
    "ltmMaxChars": 800,
    "stmUpcomingGraceDays": 2,
    "stmMaxAgeDays": 90,
    "recencyLambda": 0.05,
    "upcomingWeight": 1.5,
    "ongoingWeight": 1,
    "urgentBoost": 1.5,
    "urgentDays": 3,
    "stmMaxItems": 20,
    "stmMaxChars": 1200
  },
  "updater": {
    "enabled": true,
    "model": "qwen3.7-plus",
    "baseUrl": "",
    "apiKeyEnv": "",
    "timeoutMs": 120000,
    "temperature": 0,
    "maxTokens": 2048,
    "maxWmEntries": 64,
    "shutdownWaitSec": 2
  },
  "observer": {
    "enabled": false,
    "baseUrl": "",
    "apiKeyEnv": "",
    "intervalSec": 60,
    "timeoutMs": 60000,
    "temperature": 0,
    "maxTokens": 400,
    "maxContentChars": 400,
    "maxFrameAgeSec": 15
  },
  "wm": {
    "maxEntries": 128,
    "maxEntryChars": 200
  },
  "segment": {
    "maxTurns": 4,
    "minTurnsBeforeGapCut": 2,
    "maxChars": 1000,
    "silenceGapSec": 60
  }
}
```

`retrieve.maxChars` bounds unrendered bodies and must not exceed `retrievedMaxChars`, the rendered section budget. Background embedding timeout must be at least the live-query timeout. Visual retrieval spreads observations by `envMinGapSec`; it returns fewer results rather than padding them with near-duplicate frames.

Run `qwen-live-harness --debug` for state, counts, timing and failure diagnostics. These omit memory content and credentials. Detailed preload and consolidation audit records stay in the private library database.

## Host Bootstrap

The Qwen Live Harness Host installer is built in. On macOS, `qwen-live-harness init` checks if
the Host is installed and offers to download and install it (sha256 +
codesign + team identifier verification). The daemon also exposes HTTP
endpoints behind its Bearer token:

```bash
TOKEN=$(jq -r .token ~/.qwen-live-harness/run/daemon.json)
PORT=$(jq -r .url ~/.qwen-live-harness/run/daemon.json | sed 's/.*://')
curl -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/live/setup"
```

## Protocol v9: Visual Input and Playback Identity

The daemon speaks Qwen Live Harness Host protocol v9. Output audio carries an epoch and
`outputId`; the Host echoes both in `host.playback_started` and
`host.playback_completed`. This prevents receipts from cleared audio from
settling a newer playback stream in the same call. A Host that advertises
`outputAudioEndMarkerV1` receives an explicit end marker for each output id and
reports completion only after that marker and every scheduled frame have
drained. Consecutive response outputs may drain independently, but Qwen Live Harness
reopens the Proactive FIFO only after all of them complete. Hosts without this
capability keep the legacy playback-drain behavior.

Standalone v9 daemons advertise an optional `visualInput` object during the
welcome handshake. `host.visual_settings` changes Source/Mode for the current
call, `host.visual_frame` carries bounded Live Feed JPEGs, and
`host.capture_visual` / `host.visual_capture_result` implement correlated On
Demand capture. The built-in `qwen serve` integration uses the same pair with
source `screen` while omitting the standalone Source/Mode controls.

In Live Feed mode the selected source continuously supplies recent frames to
the foreground Omni session. In On Demand mode the foreground model calls
`appshot` for one selected-source capture. An active visual Proactive task
also requests periodic private captures for its Monitor in On Demand mode;
the Source/Mode selection does not pause those monitors. The daemon
returns its metadata and asset handle through the original
`function_call_output` continuation; it does not append that snapshot to
Realtime, commit an audio buffer, or change VAD mode. Pixel-level inspection
uses the existing handoff path with the returned asset.

Screen Live Feed and visual Proactive monitors capture the **entire selected
display**, including the desktop, menu bar and Dock, excluding Qwen Live Harness Host's own
windows. Choose **Display** under Video Source in Settings. The selection is
saved as `visualInput.screenDisplayId` in `config.json`: `primary` (default)
follows the system's primary display, or a display UUID selects that device.
An explicitly selected display that is disconnected fails without switching to
another display. Display changes discard stale captures and reset monitor visual
buffers. Both continuous and monitor frames use `liveResolution` (720p by
default), remain aspect-fitted and subject to the existing transport limits;
full-display coverage does not mean native pixel resolution. No new init prompt
is needed. Older Hosts must be updated to support full-display capture.

Foreground Screen Appshot and On Demand visual-memory observations keep the
original front-window capture. Appshot still requires Accessibility and Screen
Recording; the full-display operation needs only Screen Recording. Screen Live
Feed therefore does not require Accessibility. Camera behavior is unchanged.

Screen captures may also include Appshot accessibility metadata and a PNG
handoff asset. Camera source opens a preview/Live Feed stream at
`cameraResolution` (1280×720 by default). User Appshot requests take a separate
still image from that camera track using `cameraSnapshotResolution`; native
uses the available still-image resolution, with a video-constraint fallback
on devices without still-photo support. The preview settings are restored
after fallback capture. Unsupported native capture fails explicitly.
The camera JPEG asset keeps its independent snapshot resolution and is
limited to 8 MiB. Its transport preview, Live Feed frames, and private Monitor
frames remain limited to 190 KiB and fitted within 1920×1080. Private Monitor
captures do not take full-resolution still photos. Stop ends the call and its
monitors; the visible Camera source may keep a local preview open while idle.
The system prompt always follows the latest explicit Source and
Mode and never guesses or combines the unselected source. If the newly selected
source needs permission during an active call, the working source remains in
place until authorization succeeds, then the switch is applied atomically.

## Status

Developed in [Qwen-Live-Harness](https://github.com/QwenLM/Qwen-Live-Harness),
tracking the [Live split roadmap](https://github.com/QwenLM/qwen-code/issues/10118):

- **M1+M2** (merged): daemon, host stack, base tools, injector, permissions,
  steering, JSONL logs, Host installer
- **M4** (merged): AcpAdaptor, multi-backend routing, capability gating
- **M5** (merged in #10769): protocol v7 playback receipts and the interactive
  `qwen-live-harness init` wizard
- **This extension**: protocol v9 visual input and fenced playback receipts,
  6 configurable Proactive tools, 2 Memory tools with local multi-library
  storage (both features enabled by default), and configurable desktop controls
- **M3 stage 1**: opt-in, read-only local terminal discovery is implemented.
  Controller handoff and incoming peer report announcements remain follow-up
  stages; full M3 voice acceptance is not implied by discovery support.
- Built-in Live retirement is implemented in a companion qwen-code cleanup
  branch; the new repository owns daemon and Host builds and releases.

The current source version is 0.3.0 and requires the matching v9 Host under the
new application and bundle identities. Build both components from this repository
until the renamed npm package and signed Host are published. Previously released
artifacts are not an old-name fallback, even if their version or protocol matches.
Real Qoder account tests require an explicit opt-in:
`RUN_QODERCLI_SMOKE=1 npx vitest run src/manual/qodercli-acp.test.ts` from this
package directory. Ordinary unit and protocol tests do not use live accounts.

## Attribution

The Proactive and Memory implementations include TypeScript adaptations of
`qwen-omni-realtime-agent` v0.1.0 (`qwen_omni_realtime_agent/proactive` and
`qwen_omni_realtime_agent/memory`), Copyright 2026 Alibaba Group Holding Limited,
licensed under Apache-2.0. This port modifies those components for Qwen Live Harness's
DashScope connection, tool authority, playback queue, local storage and Host
interface. Original copyright notices are retained in adapted source files.
