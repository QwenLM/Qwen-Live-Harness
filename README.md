# Qwen Live Harness

Qwen Live Harness is a standalone voice application for working with coding agents.
Talk to the realtime model, delegate tasks to Qwen Code, Qoder, or other ACP
agents, and receive results and permission requests while the work runs.
The macOS Host provides the global shortcut, audio, screen and camera input.
The daemon owns voice conversations, Proactive monitors and local Memory.

This repository was extracted from [Qwen Code](https://github.com/QwenLM/qwen-code)
after [#11369](https://github.com/QwenLM/qwen-code/pull/11369).
See [migration provenance](docs/migration.md) and the
[extraction plan](docs/design/2026-09-11-repository-extraction.md).

## Build from source

Node.js 22.13 or later is required. The desktop Host currently requires macOS.

```sh
git clone git@github.com:QwenLM/Qwen-Live-Harness.git
cd Qwen-Live-Harness
npm ci
npm run build
npm run typecheck
npm test
```

The daemon installs independently of Electron and Qwen Code. To build the
matching Host, install Xcode command-line tools and Node headers, then run:

```sh
npm ci --prefix packages/qwen-live-harness-host
npm run build:host
npm run typecheck:host
npm run test:host
```

The daemon and Host use paired package versions and Host protocol **v9**.
Automatic installation downloads the matching signed Host release. See the
[Host guide](packages/qwen-live-harness-host/README.md) for packaging and the
release workflow for signing requirements.
An installed Host or download manifest with a different version is not accepted;
upgrade the CLI and Host together, even when the protocol version is unchanged.

## Configure and run

```sh
npm run init
npm start
```

The equivalent commands after installing the unscoped npm package globally are
`qwen-live-harness init` and `qwen-live-harness`. Initialization saves your
configuration, offers to download and install the macOS Host, and registers the
current Node/CLI installation for desktop startup. It does not open the Host or
start a call.

After initialization, run `qwen-live-harness` (or `npm start` from this checkout)
to start or reuse the daemon and open the installed Host. You can also open
**Qwen Live Harness Host** from Applications or Launchpad: it connects to the
existing daemon, or starts the registered daemon when needed. Opening either
entry point again reuses the running application. Existing configured users can
run the CLI once to register desktop startup without repeating the wizard.
When the CLI starts a new daemon it stays in the foreground; `Ctrl+C` follows
the normal shutdown path. When it reuses a daemon, it exits after opening Host.
Closing the daemon during CLI startup does not make the opening Host restart it.

Downloading only the Host does not install Node or the CLI. If these are absent,
the Host shows setup instructions. Install Node.js and the CLI, then complete
`qwen-live-harness init` once. Moving or removing the registered Node/CLI
installation requires running the working CLI again to refresh registration.

For development with a source-built Host, run the two components separately:

```sh
# Terminal 1: run only the daemon, without opening the installed app
npm start -- --daemon-only --debug

# Terminal 2: run the source-built Host
npm --prefix packages/qwen-live-harness-host start
```

The internal `--daemon-only` mode is intended for component development and
automated tests. Host diagnostics use
`npm --prefix packages/qwen-live-harness-host start -- --live-harness-debug`.
These source commands do not require a globally installed CLI. Before a signed
Host release is available, skip the wizard's download offer and use this
source-built setup.

Desktop startup registration is stored with discovery in
`~/.qwen-live-harness/run/runtime.json`; it records executable paths and the
launch environment's PATH, not API keys. Bootstrap logs are saved under
`~/.qwen-live-harness/run/logs/`, retaining five files of at most 1 MiB each.
Startup failures show an error instead of repeatedly restarting the daemon.
Cold coding-agent installation can take several minutes; desktop startup allows
both backend initialization phases to finish, with an eleven-minute outer limit.
Quit still cancels an in-progress startup.
Use **Retry startup** in the menu bar to retry explicitly, or quit and reopen
the Host. If the CLI was stopped while opening Host, merely activating that
window does not recreate the stopped daemon.
`End call` leaves the application running; `Quit Host` closes both components.

The wizard detects supported agents already installed on your machine. Select
an ACP backend such as `qwen --acp` or `qodercli --acp`; `qwen serve` is needed
only when you explicitly use the optional REST/SSE backend. A DashScope API key
is required for realtime voice. Proactive and Memory can make additional model
requests; configure them in the wizard or settings.

This is a **breaking identity change with no compatibility aliases**. Run
`npm run init` for a fresh configuration under `~/.qwen-live-harness`; configuration,
conversations and Memory from the previous installation are not read or copied.
Host discovery is now `~/.qwen-live-harness/run/daemon.json`, and environment
overrides use only `QWEN_LIVE_HARNESS_*`. The Host is now **Qwen Live Harness Host**
with bundle ID `com.alibaba.qwen-live-harness.host` and install path
`/Applications/Qwen Live Harness Host.app`; macOS permissions may need to be granted
again. Quit the previous daemon and Host before starting these builds. The rename
does not delete previous apps, data, permissions or shell configuration, and does
not modify any remote release feed. See [migration details](docs/migration.md).

See the [daemon guide](packages/qwen-live-harness/README.md) for backend configuration,
visual input, Memory, diagnostics and capability limits.

M3 now has opt-in discovery and authorized text instructions for existing local Qwen terminal sessions.
Configure `peerDiscovery` on a `qwen-code` backend as described in the
[terminal discovery guide](packages/qwen-live-harness/README.md#terminal-session-discovery-m3-stage-1).
Add an explicit controller grant to send text and inspect separate delivery receipts;
receiving peer reports is a later stage. Ordinary
backend completion and permission announcements remain supported; the retired
private injected speech channel is not used.

## Tests and compatibility

`npm test` runs the daemon, release-tooling and self-contained protocol tests
with local fake providers. It does not require API credentials or device access.
`npm run check:package` installs and checks the actual npm tarball in a temporary
directory. `npm run check:boundaries` checks repository dependency boundaries.

The migrated M1/M2/M4 compatibility tests use an external, built Qwen CLI:

```sh
TEST_CLI_PATH=/absolute/path/to/qwen/cli.js npm run test:backends
```

They use isolated data directories and local fake model endpoints. The CLI is
a test backend, not part of this repository's build or runtime requirements.
Hardware, real providers, signing and notarization require separate validation.

## License

Apache-2.0. Original copyright notices are retained; see [LICENSE](LICENSE).
