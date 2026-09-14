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

The current source version is **0.3.0**, using Host protocol **v9**. The renamed
package and signed Host must be published under their new identities before
registry installation or automatic Host download can be used. Do not substitute
an older differently named Host. See the [Host guide](packages/qwen-live-harness-host/README.md)
for packaging and the release workflow for signing requirements.

## Configure and run

```sh
npm run init
npm start
```

In a second terminal, start the matching source-built Host:

```sh
npm --prefix packages/qwen-live-harness-host start
```

For foreground diagnostics, use `npm start -- --debug` for the daemon and
`npm --prefix packages/qwen-live-harness-host start -- --live-harness-debug` for the
Host. These source commands do not require a globally installed CLI. The
published npm package and CLI are both named `qwen-live-harness` (unscoped);
an installed CLI uses `qwen-live-harness init` and `qwen-live-harness`.
Until a new-name signed Host is available, decline the wizard's Host download
offer and use the source-built Host above.

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

This migration does not implement M3 peer integration. Backend completion and
permission announcements remain supported, but the former private injected
mid-turn speech channel is retired. Discovering and controlling existing terminal
sessions through peer messaging is separate follow-up work.

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
