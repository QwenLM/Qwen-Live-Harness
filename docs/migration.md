# Migration from Qwen Code

Source repository: https://github.com/QwenLM/qwen-code

Source commit: `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`, the merge of
[#11369](https://github.com/QwenLM/qwen-code/pull/11369) on 2026-09-11.
The imported snapshot retains source copyright notices and Apache-2.0 licensing.
Original commit history remains available in the source repository at this SHA.

The imported daemon and Host now live in `packages/qwen-live-harness` and
`packages/qwen-live-harness-host`. The migration also imports the eight M1/M2/M4
integration suites and their local provider fixtures, and the Host release/OSS
tooling. Repository-specific build dependencies and tests are
adapted here. Qwen Code's core, CLI, serve and SDK implementations are not
copied into the application. The REST/SSE adaptor bundles the official SDK's
HTTP client at build time. The SDK is a development dependency because its npm
package also contains a Qwen CLI; that package and CLI are not installed with
the published Live daemon. The bundled client's license ships in
`dist/vendor/qwen-code-sdk-LICENSE`.

## Roadmap status

- [#10367](https://github.com/QwenLM/qwen-code/pull/10367): M1/M2 standalone
  daemon, scheduling tools, result backflow and permission forwarding.
- [#10617](https://github.com/QwenLM/qwen-code/pull/10617): M4 ACP and
  multi-backend routing, steering and permission fixes.
- [#10769](https://github.com/QwenLM/qwen-code/pull/10769): playback receipts
  and interactive onboarding. Despite its M5 title, it did not remove the old
  built-in Live implementation.
- [#11369](https://github.com/QwenLM/qwen-code/pull/11369): protocol v9,
  visual input, Proactive, Memory and paired Host changes.
- [#10118](https://github.com/QwenLM/qwen-code/issues/10118): the original
  roadmap also includes discovery/control of user-owned terminal sessions.
  M3 is tracked separately from repository extraction; upstream protocol support
  being merged does not by itself make that feature available in Live.

M3 is explicitly deferred from this migration. Both repositories retire the
private Live activation/speech RPCs instead of keeping them as a hidden fallback.
Backend turn-completion announcements, permission reminders and steering remain
available through the ordinary ACP/REST contracts. Mid-turn reports using the
retired injected speech tool are no longer available; public peer discovery,
control and progress reporting belong to M3. Live's own Proactive monitors are
unaffected.

## M3 discovery follow-up

After extraction, M3 stage 1 adds opt-in local terminal discovery to
QwenCodeAdaptor. The entries are read-only; terminal handoff and peer report
announcements remain later stages. The original migration boundaries above
describe the extraction snapshot. See the
[terminal discovery guide](../packages/qwen-live-harness/README.md#terminal-session-discovery-m3-stage-1)
for current configuration and limits.

## Breaking naming change (2026-09-14)

The original extraction preserved application identities. The subsequent naming
change intentionally replaces them without aliases, legacy discovery, environment
fallbacks or automatic data migration. Current identities are:

| Surface                                       | Current identity                                                      |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Product                                       | `Qwen Live Harness`                                                   |
| Public npm package and executable             | `qwen-live-harness` (unscoped)                                        |
| Private workspace / Host packages             | `qwen-live-harness-workspace` / `qwen-live-harness-host`              |
| Default config, conversations and Memory root | `~/.qwen-live-harness`                                                |
| Default Host discovery                        | `~/.qwen-live-harness/run/daemon.json`                                |
| Product environment overrides                 | `QWEN_LIVE_HARNESS_*`                                                 |
| Host app / install path                       | `Qwen Live Harness Host` / `/Applications/Qwen Live Harness Host.app` |
| macOS bundle ID                               | `com.alibaba.qwen-live-harness.host`                                  |
| Host debug switch                             | `--live-harness-debug`                                                |
| Release tags                                  | `qwen-live-harness-host-vX.Y.Z` / `qwen-live-harness-host-latest`     |
| Release assets / OSS prefix                   | `Qwen-Live-Harness-Host-*` / `qwen-live-harness-host`                 |

Quit the previous daemon and Host before using the renamed builds. From the
repository root, run `npm run init`, then `npm start`; in a second terminal use
`npm --prefix packages/qwen-live-harness-host start`. Update shell variables and any
explicit path overrides yourself. The renamed default data directory starts
fresh: previous credentials, sessions, Memory and Host preferences are not read
or copied. Previous applications and data are left in place, not uninstalled or
deleted. Do not point a new data override at private old data unless you explicitly
intend to use it.

The new app has a different macOS permission identity; grant required permissions
again. Developer ID team `NF4574S59H` remains the actual publisher identity, not
a product name. Hardware permissions and signed installs need separate validation.
The standard `DASHSCOPE_API_KEY` credential and backend commands such as `qwen
--acp` / `qwen serve` are provider/backend contracts, not renamed product aliases.

## Publication boundary

The current source version remains 0.3.0 with protocol v9. Renaming source does
not publish the unscoped npm package, change registry ownership, or create/move
GitHub releases and OSS objects. Build both components together until matching
new-name artifacts are published. Installers use only the new asset names, bundle
ID, release tags and OSS prefix; previously published artifacts are not a fallback,
even if their version or protocol matches.

The existing `qwen-code-assets` OSS bucket is publisher infrastructure; the
product-specific prefix changes independently. When the repository is private,
its GitHub fallback is available only to users with access. Public installation
requires the publisher setup documented in the Host guide. No secrets, repository
visibility settings, old release feeds or installed applications are changed by
this source update.
