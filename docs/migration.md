# Migration from Qwen Code

Source repository: https://github.com/QwenLM/qwen-code

Source commit: `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`, the merge of
[#11369](https://github.com/QwenLM/qwen-code/pull/11369) on 2026-09-11.
The imported snapshot retains source copyright notices and Apache-2.0 licensing.
Original commit history remains available in the source repository at this SHA.

The migration imports `packages/qwen-live`, `packages/live-host`, the eight
M1/M2/M4 Live integration suites and their local provider fixtures, and the
Host release/OSS tooling. Repository-specific build dependencies and tests are
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

## Stable user state

No automatic migration or deletion of configuration, credentials or sessions
is performed. Keep the same data-directory overrides when switching binaries.
The command remains `qwen-live`, the daemon package remains
`@qwen-code/qwen-live`, and default data remains `~/.qwen-live`.

Host keeps its existing application name, bundle ID, signing team and discovery
path so repository ownership does not introduce a different macOS application
identity. Stop the old Live daemon before starting its replacement; discovery
ownership checks intentionally reject two active owners.

## First release

The last npm release and public Host manifest are 0.2.0; the latter uses protocol
v7. The extracted candidate is 0.3.0 with protocol v9. Build both components
together until a matching signed Host release is available.

At extraction the new repository is private and has no configured release
credentials. Its GitHub release URLs are not public downloads. The release
workflow and public OSS distribution require the publisher setup documented
with the workflows. Code migration does not publish npm, change repository
visibility, or transfer signing secrets automatically.
