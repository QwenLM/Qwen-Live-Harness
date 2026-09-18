# Live conversation and image handoff reliability

[简体中文](live-image-handoff-reliability.zh-CN.md)

## Problem

On Demand captures previously returned local image references without pixels to the foreground Realtime model. Even a simple visual question required a separate backend handoff, which the foreground model could omit while promising an answer. Provider response splits also lost the originating user capability after a tool continuation. Finally, expired image references were silently omitted from backend tasks.

## Behavior

- Preserve an existing user tool capability and input identity across an uncancelled provider split when no newer user input supersedes it. Synthetic notifications never acquire that capability.
- Send each requested Screen or Camera frame from the existing Host directly to the current Realtime connection before returning the Appshot result. Answer ordinary visual questions directly, including when no backend is configured. Live Feed is unchanged.
- A successful receipt reports image delivery to Realtime; it does not claim that the model interpreted the image. Answer from the latest actual image, not dimensions, old frames, or an asset reference. Screen accessibility text remains supplementary evidence. Only explicit backend work needs image handoff.
- Reject delivery when the capture outlives its tool request, active call, Realtime connection, or visual settings. Failed image sends return an error rather than a success receipt or automatic backend fallback.
- Session creation receipts state that no task has been submitted and identify handoff as the next action for requested work.
- If any requested image reference is unknown, expired, unreadable, or empty, reject the entire handoff with `image_unavailable`. Do not submit a partial or text-only task. Announce the failure through the existing speech queue after the active response finishes; a receipt alone does not resume a handoff response.
- Preserve JPEG bytes and MIME type and name camera attachments with `.jpg`; Screen PNGs retain `.png`.

## On Demand media commit

The configured provider rejected a post-commit image without fresh audio, and continuous quiet PCM plus an image append did not produce correct content answers. An input-image message also failed on this endpoint. In contrast, a separate manual media commit followed by its empty transcription produced correct answers for three distinct images in one connection.

For a current Appshot call, temporarily set turn detection to manual, append one second of zero PCM plus the JPEG, and commit them together. Hold incoming microphone PCM locally (bounded by the existing 1 MiB limit). Track the media commit identifier separately from real speech input, wait for its empty final transcription, restore semantic VAD, and flush buffered microphone frames in order before completing the original tool result. This is a media input, not a new user utterance or tool authorization. No user audio or text is replayed to force another turn.

Reject stale requests and concurrent media submissions. A speech event or nonempty media transcription makes input ownership ambiguous, so fail explicitly and ask the user to repeat. A failed send, closed connection, overflow, or ten-second timeout settles the image request and retires the affected connection when needed. Settings changes or response cancellation invalidate success while allowing an already submitted media transaction to restore microphone handling. Known media events never enter captions, dialogue memory, or user-input arbitration.

## Session state and recovery

- Changing the visual source or acquisition mode refreshes both session instructions and silent state. Later responses must not retain the previous Screen / Camera setting.
- Announce each new permission request once. Interruptions, unrelated user turns and requests to wait retain silent approval context without timed reminders. Only an explicit user decision can authorize the permission tool.
- Tool descriptions and system instructions agree that an explicit new-task request requires session creation and task submission, not a plain lookup or spoken promise. Actual model adherence still needs observation.
- Ignore an idless completion on an idle fresh connection. A missing response identifier while a request awaits acknowledgement remains a protocol error.
- Use the unified transport recovery layer from main 0.4.4 for response-state loss instead of adding a second orchestrator reconnection path. Host call state, backend tasks, pending permissions/results, and Memory objects survive. Recovery allows at most two connection attempts and fences old callbacks, captures, and asynchronous tool results from the replacement transport.
- Resume only safely retained user text or audio that has not already dispatched tools. Never replay dispatched tools. Show a repeat-input hint when input cannot be restored; end the call explicitly when recovery fails. Muted heartbeats and the media commit’s zero PCM are excluded from replayable real microphone data.

## Boundaries

No new process, provider, model, media permission, automatic capture, or permanent image archive is introduced. On Demand image bytes now go to the same Realtime provider already receiving live audio and Live Feed frames, using its existing JPEG input channel and size limits. This changes visual inference billing from the configured backend to the current Realtime model for ordinary visual questions; the cost difference is not measured. Optional local image assets remain available for explicit backend tasks with the same temporary-file lifetime. Recovery retains main’s limit of two connection attempts to the existing provider and does not repeat backend tasks. Receipt guidance improves model behavior but is not a deterministic guarantee of model adherence.

## Verification

Verify ordinary and repeated provider splits, new user interruptions, cancellation, and synthetic notification restrictions. First establish with the actual provider that a separately committed image delivered after the Appshot call is available to the continuation. Expected answers must exist only in synthetic image pixels, not prompts, accessibility text, filenames or receipts. Verify consecutive distinct captures, Screen/Camera switching, no-backend operation, send failure and stale-capture rejection. A successful WebSocket send is insufficient evidence. Verify retained explicit image handoffs and rejection of missing or partially available attachments. Keep private camera images out of tracked artifacts and remove diagnostic copies after inspection.

Verify both cancellation timeout phases, failed recovery, repeated timeout, stop/reconnect races, old output isolation, uncommitted input and pending approval preservation. A continuous real-model scenario covers new tasks, deferring approval, Camera switching, image handoff and later approval. Synthetic protocol tests or one successful model turn do not establish complete product behavior.
