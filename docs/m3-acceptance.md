# M3 setup and acceptance

M3 lets a call discover existing local Qwen terminal sessions, send explicitly
authorized text instructions, and receive session progress/results for speech.
The configuration and public CLI diagnostics are described in the
[setup guide](../packages/qwen-live-harness/README.md#terminal-setup-and-diagnostics-m3-stage-4).

## Supported boundaries

| Component                   | Contract                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live runtime                | Node 22.13+; repository validation uses Node 22.                                                                                                                                       |
| Qwen peer protocol          | Pinned official peer sources with build-time hash verification; real CLI regression baseline: Qwen Code 0.23.3. A version string alone is not a compatibility check.                   |
| Terminal discovery/delivery | Local macOS/Linux Qwen home under the same user; running TUI with messaging enabled. A `qwen-code` backend retains its required `qwen serve` REST preflight.                           |
| Host                        | macOS, matching daemon/Host package versions and protocol v9. Linux can exercise peer/daemon tests but not physical Host acceptance.                                                   |
| Controller grant            | Explicitly created by the user in that Qwen home; environment reference or hidden token input. Setup/doctor never mint, renew or revoke grants.                                        |
| Reports                     | Public `send_message` exposed and approved by the receiving/sending Qwen sessions as appropriate; per-call Live address, independent report records and speech queue.                  |
| Existing backends           | Managed REST/SSE and ACP control/completion/permission paths remain supported. Disabling peer discovery preserves those backends.                                                      |
| Outside this slice          | Windows peer support, cross-machine discovery, terminal image delivery, stop/permission voting, full transcript synchronization, guaranteed execution-turn identity and offline calls. |

## Repeatable checks

Use an isolated data directory and Qwen home. Use a test controller grant, then
revoke that test grant when finished. Do not change the user's normal sessions,
grants or model credentials to run automatic tests.

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run check:boundaries
npm run check:package
npm run lint
npm run format:check

npm ci --prefix packages/qwen-live-harness-host
npm run typecheck:host
npm run test:host
npm run build:host
```

`npm run check:package` installs the actual tarball and repeats public CLI and
full-process integration checks against the installed entry. The setup suite
uses real CLI prompts, isolated config files and local HTTP fixtures. It checks
configuration/default/ACP preservation, environment token references, no-op
reconfiguration, cancellation, concurrent edits, safe diagnostics and redirects.
Fake providers and fixture tokens do not prove production authentication or audio.

For real Qwen terminal and ACP protocol checks, set `TEST_CLI_PATH` to the real
Qwen CLI entry and run the relevant suites. They create isolated test homes and
local fake model/Realtime/Host providers:

```bash
TEST_CLI_PATH=/absolute/path/to/qwen/cli.js npm run test:backends -- qwen-live-harness-m3-discovery qwen-peer-instructions qwen-peer-reports
```

Record the exact Live commit, Qwen version, tarball/Host build, Node version,
commands/results and cleanup. Confirm that call shutdown removes Live's test
socket/registry entry and that ending a call does not cancel existing terminal
work. No fake test result should be described as real microphone acceptance.

## Host and physical voice acceptance

This is a manual checklist, not a declaration that the following has passed.
Use the matching source-built or packaged Host and daemon. Physical voice and
production-provider speech acceptance remain pending until separately recorded.

1. Run normal `init` for a new Live config, or `init --peers` for existing settings.
   Select the local test Qwen home and running `qwen serve`. Verify that existing
   ACP/default backend settings remain intact. Enable target messaging, create an
   explicit test controller grant, and enable report reception.
2. Run `doctor --peers`. Resolve actual errors. In Host, independently check the
   microphone, speaker mute, model connection and call state; doctor cannot verify
   those through the current read-only HTTP interface.
3. Start two manually controlled Qwen TUIs. In a real voice call, ask to list
   sessions. Confirm both terminal identities, disambiguate equal/long names, and
   verify the Terminal sessions section in Chinese/English and a narrow window.
4. Speak an instruction for one terminal. Confirm the original instruction arrives
   there and the delivery receipt changes independently of task counts. Exercise
   accept, hold then accept, and hold/refuse; do not infer execution completion
   from delivery alone.
5. Have both sessions send progress/blocker/result reports to the current call's
   address. Verify source attribution and that reports wait for user speech, model
   responses and Host playback. Check mute, interruption, long text and late reports.
6. Run a managed daemon task and an ACP task alongside terminal work. Verify normal
   results and permission handling remain functional; reports cannot approve tools
   or manufacture task-completion events.
7. End the call while terminal work continues. Start a second call. Verify a new
   report address, no old queued speech, and rejection of the prior call's address.
8. Disable peers through `init --peers`, restart Live, and confirm daemon/ACP still
   work while the disabled backend publishes no Live peer endpoint. Revoke only
   the test controller grant and close the test processes.

Record separate outcomes for protocol tests, packaged installation, actual Host
UI, physical microphone/speaker, and production model. A merged PR, green CI,
release build or successful socket connection is not full M3 voice acceptance.
