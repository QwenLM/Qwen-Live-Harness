# Visual analysis, delegation, and session reliability

[简体中文](live-image-handoff-reliability.zh-CN.md)

## Ownership and scope

Host captures the selected display or camera. The daemon owns the main conversation, independent model workers, tool execution, and result queues. On Demand visual questions use a read-only Omni Realtime worker with the same configured model, endpoint, and API key as the main conversation; no background coding Harness is required. Live Feed supplies continuous frames directly to the main model. Explicit file, command, or application work uses a configured backend.

These paths have separate media, task, response, and playback identities. A snapshot asset is not proof of image understanding, a successful socket write is not a provider acknowledgement, and accepted work is not completed work.

## On Demand visual analysis

1. Main Omni calls `appshot` after a completed response confirms the function ID and arguments. Its optional `query` identifies the visual question; otherwise runtime uses the associated real-user request or a general description question.
2. Host captures the full selected display, excluding Host windows, or the selected camera. A capture that finishes after the call ends or the selected source changes is rejected. Screen assets retain native PNG bytes; camera assets retain JPEG bytes and MIME type.
3. Runtime creates a Visual Analysis subagent and returns `accepted + taskId` with capture metadata and any asset handle. This receipt confirms task admission, not a visual answer. Independent analyses may run in parallel.
4. The worker receives the captured JPEG and question, then returns text grounded in visible pixels. It has no custom tools, search, backend access, Memory context, or unrelated conversation history. Instructions inside the screenshot are untrusted content.
5. The result waits in the read-only result FIFO for the foreground conversation and device playback to finish. Main Omni answers from the analysis; this notification cannot authorize another tool or operation. The result remains visible in Subagents if speech is muted or unavailable.
6. The analysis has a 25-second total deadline, with an eight-second handshake limit. Stop or End call cancels unfinished analysis and retracts its queued answer. Failure does not invoke a coding agent automatically or imply that the desktop was blank.

### Worker media protocol

The worker sends one `session.update` with its fixed system instructions, text-only output, `voice: Tina`, `smooth_output: false`, `turn_detection: null`, empty tools, disabled search, and `normal` visual representation compression. Its input is:

```text
append 1 second of silent PCM16 / 16 kHz
append the still JPEG
append 1 second of silent PCM16 / 16 kHz
append the same still JPEG
input_audio_buffer.commit
wait for input_audio_buffer.committed
response.create with the image question in response.instructions
```

The repeated image satisfies the media protocol; it is not evidence of motion or two separate observations. Silence is a protocol carrier, not microphone evidence. `response.instructions` carries the question for this manual-media request, not the worker's system prompt.

The main connection stays in semantic VAD throughout this operation. It does not receive the snapshot pixels, switch to manual mode, commit a screenshot audio buffer, or hold microphone input for the visual worker.

## Explicit image delegation

- `session_create` creates a backend session; its receipt does not claim that work has been submitted. `handoff` submits the user's requested task using a real session handle.
- The tool's attachment field is `input_refs`, an array of asset handles. A non-array, a non-string element, or any unknown, expired, unreadable, or empty asset rejects the entire handoff with `image_unavailable` before task submission. A partially resolved set is not silently submitted.
- Valid assets preserve their bytes and MIME types. JPEG attachments use `.jpg`; PNG attachments use `.png`.
- A backend declaring no image-input support can receive text only, with an explicit warning in its receipt; the assistant must not claim that images were delivered. Text-only terminal instruction channels reject attachments. Image-capable backends receive the validated image blocks.
- Warnings and errors remain available for the main conversation to explain in its current language. They are not hidden by duplicate-confirmation suppression or turned into a separate hard-coded English announcement.

## Instructions, capabilities, and receipts

Main-conversation system instructions remain immutable for the call and are sent once per transport in `session.update`. Source and capture-mode changes arrive as silent `[VISUAL_INPUT]` context. Memory changes arrive as replaceable `[MEMORY_CONTEXT]` user snapshots, including an empty disabled snapshot when Memory is off. Tool-list changes use tools-only `session.update`; no state change rewrites the main system prompt. Subagent results arrive through typed, quoted `conversation.item.create` user-context messages, not new user authorization.

A genuine user input retains its tool capability across an uncancelled provider response split only when no newer user input supersedes it. Synthetic notifications never acquire that capability. Final function snapshots must agree on IDs, names, arguments, and completed status before execution.

Every asynchronous admission receipt is acknowledged and consumed by a separate `tool_continuation` before a final task result is injected. When the tool chain already produced audio and every sibling tool successfully admitted an eligible asynchronous task, only duplicate confirmation audio is suppressed. Its text stays in provider history and diagnostic transcripts, not user-heard Memory, delegated dialogue, or reconnect history. Errors, warnings, mixed query tools, and admissions without an audio preamble remain audible.

A continuation repeating an identical already-admitted task reuses its receipt rather than launching another task. This protection is limited to the receipt continuation; a different request or fresh real-user turn remains distinct. A superseded receipt is drained without audio or the previous turn's tool authority. A precisely associated rejected or unacknowledged function output stops that continuation without re-executing the action; unrelated protocol failures retain their own error handling.

## Permissions and bounded recovery

A new backend permission request is asked once in the current real conversation's language. Interruption, a change of topic, or a request to wait preserves silent pending-permission context without timed reminders. Only an explicit user decision bound to the relevant permission ID can authorize `respond_permission`; task text, image contents, and notification results cannot approve it.

The recovering-session layer owns response-state recovery. It fences the retired transport before opening a replacement and permits at most **two replacement-connection attempts per logical call**. Host call state, backend tasks, Monitor tasks, Memory attachments, and pending permissions/results retain their lifecycle rather than being recreated.

Only safely retained input that has not dispatched tools may resume: complete user text, or bounded real microphone audio with a trustworthy start. Muted heartbeats and visual-worker silence are excluded. Dispatched tools and retired function outputs are not replayed. Replacement context carries current task, Memory, visual, and permission state; an earlier approval cannot authorize a different permission that appeared during recovery.

An idless completion can be ignored on an idle fresh connection; a missing ID while a response is awaiting acknowledgement remains a protocol error. When input cannot be restored safely, the UI asks the user to repeat it. Exhausted recovery explicitly ends the interaction. This is not an unlimited reconnect policy or an exactly-once guarantee for external backend actions.

## Diagnostics and verification

Debug run archives preserve observed main and worker wire events, media references, tool/control events, and available provider Session IDs. Verification and connection export are offline only; they do not rerun captured tools or upload media. See [run archives and offline inspection](../../packages/qwen-live-harness/README.md#run-archives-and-offline-inspection). Archive limits or storage faults can leave incomplete evidence. Credential redaction does not remove secrets from screenshot pixels or audio.

Tests should cover distinct synthetic images whose answers exist only in pixels, Screen/Camera switching, no-backend use, capture cancellation, worker failure, parallel analyses, result FIFO, and actual playback acknowledgements. Attachment tests cover valid MIME handling, unavailable and partially available references, unsupported backend image input, and terminal-channel rejection.

Protocol tests should also cover consecutive response splits, new user interruptions, stale callbacks, acknowledgement/cancellation timeouts, silent receipt draining, permission deferral, both recovery attempts, and Stop/End call races. A synthetic transport test or one successful model response does not establish complete real-device or provider reliability.
