# Qwen Live Harness

Qwen Live is a standalone voice application for working with coding agents.
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
npm ci --prefix packages/live-host
npm run build:host
npm run typecheck:host
npm run test:host
```

The first extracted version is **0.3.0**, using Host protocol **v9**. Until its
signed release is published, an older released Host is not a compatible
replacement for the matching build. See the [Host guide](packages/live-host/README.md)
for packaging and the release workflow for signing requirements.

## Configure and run

```sh
npm run init
npm start
```

The wizard detects supported agents already installed on your machine. Select
an ACP backend such as `qwen --acp` or `qodercli --acp`; `qwen serve` is needed
only when you explicitly use the optional REST/SSE backend. A DashScope API key
is required for realtime voice. Proactive and Memory can make additional model
requests; configure them in the wizard or settings.

Configuration, conversations and Memory remain in `~/.qwen-live`. The default
Host discovery file remains `~/.qwen/live/daemon.json`. Existing custom data
directories and the Host application identity are preserved. A repository
migration does not require copying your API key or deleting existing data.

See the [daemon guide](packages/qwen-live/README.md) for backend configuration,
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
