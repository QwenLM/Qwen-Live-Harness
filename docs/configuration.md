# Configuration and Features

[简体中文](configuration_ZH.md) | English

[Home](../README.md) · [Advanced configuration for developers](../packages/qwen-live-harness/README.md#advanced-configuration)

After initialization, most everyday options are available in **Settings** beside the Pebble interaction card. Open the configuration file when you need to change a model, API key, image resolution, or other advanced option.

## Where to change a setting

| I want to…                                         | Where to go                                        |
| -------------------------------------------------- | -------------------------------------------------- |
| Change the microphone                              | Settings → Sound → Microphone                      |
| Switch between screen and camera                   | Settings → Video Source                            |
| Continuously share the current view                | Settings → Capture Mode → Live Feed                |
| Choose a display                                   | Settings → Video Source → Display                  |
| Enable memory, select a library, or rename it      | Settings → Personalization → Memory                |
| Change the color palette                           | Settings → Personalization → Color palette         |
| Switch language or light/dark theme                | Settings → Personalization → Language / Appearance |
| Change a model, API key, resolution, or frame rate | Settings → Open configuration                      |
| Start or end an interaction                        | Start / End call in the UI, or `Command+E`         |

## Edit your configuration in five steps

1. **Open the file.** Click **Open configuration** in Settings to open `config.json` in your computer's default editor.
2. **Make a backup.** Before your first edit, copy the file to a name such as `config.backup.json`.
3. **Change only the fields you need.** Find the matching settings in the examples below and keep the rest of your file.
4. **Save the file.** The format is JSON: use double quotes around strings, do not add comments, and do not leave a trailing comma after the final item.
5. **Quit and restart.** Fully quit Qwen Live Harness and open it again. End call alone does not reload the entire configuration.

The default file is `~/.qwen-live-harness/config.json`. If you use another configuration directory, Settings opens the actual file in use.

If Settings is unavailable, use Finder's **Go to Folder** command to open `~/.qwen-live-harness`, then open `config.json` with a text editor. This file can contain API keys; remove secrets before sharing a copy.

The JSON examples below are **fragments to merge into your existing file**, not replacements for the whole file. If a `memory` section already exists, edit fields inside it instead of adding a second `memory` section.

Running initialization again and confirming overwrite regenerates the configuration. Editing the file directly is usually easier when changing just one or two options.

## Models, API keys, and service region

For first-time setup, use the initialization wizard:

```sh
qwen-live-harness init
```

It asks for your API key, Realtime model name, and service region. Use the left/right arrow keys to choose a region and Enter to confirm; Beijing is selected by default.

| Service        | Wizard option |
| -------------- | ------------- |
| Mainland China | Beijing       |
| International  | Singapore     |

API keys for Beijing and Singapore **are not interchangeable**. Create the key in your selected region and confirm that the model is available there. See the [official API key guide](https://www.alibabacloud.com/help/en/model-studio/get-api-key).

The wizard fills in the endpoint for your selected region.

<details>
<summary>Change the region directly in the configuration file</summary>

Update both `realtimeApiKey` and `realtimeEndpoint`; other settings can remain unchanged:

| Region    | `realtimeEndpoint`                                     |
| --------- | ------------------------------------------------------ |
| Beijing   | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`      |
| Singapore | `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime` |

</details>

To change only the key or model within the same region, edit these fields:

```json
{
  "realtimeApiKey": "sk-your-api-key",
  "realtimeModel": "qwen3.8-omni-flash-realtime"
}
```

The default main model is `qwen3.8-omni-flash-realtime`. For another model or an invitation-only alias, enter the **complete Realtime model ID** provided by the service, not its marketing name. An explicit model in your existing configuration takes precedence over the default and is not automatically replaced.

### Common settings at a glance

| Field              | Default or common value         | When to change it                                   |
| ------------------ | ------------------------------- | --------------------------------------------------- |
| `language`         | `"zh-CN"` or `"en"`             | Fixed UI text; changing it in Settings is easier    |
| `realtimeApiKey`   | Entered during initialization   | Change account or service region                    |
| `realtimeModel`    | `"qwen3.8-omni-flash-realtime"` | Change the live conversation model                  |
| `realtimeEndpoint` | Beijing endpoint                | Switch between Beijing and Singapore                |
| `voice`            | `"Tina"`                        | Change the voice; use a name supported by the model |
| `shortcut`         | `"Command+E"`                   | Change the start/end interaction shortcut           |

Memory and Proactive also use the selected region by default. Separate endpoints are usually unnecessary.

## Theme palette

Choose a color under **Settings → Personalization → Color palette**. The seven named swatches apply immediately to the main UI and task window, and your choice is saved for the next launch. Iris is the default.

You can also set the top-level field in your configuration:

```json
{
  "themeColor": "iris"
}
```

Supported values are `iris`, `clay`, `sage`, `tide`, `graphite`, `rose`, and `berry`. If you edit the file manually, restart Host or reconnect the daemon to apply it; changing the palette in Settings needs no restart. Missing or invalid values use Iris. Light, dark, and system appearance are separate settings under **Personalization → Appearance**.

## Visual input

Choose **what to see**, then **when to see it**:

- **Video Source → Screen**: use your computer screen.
- **Video Source → Camera**: use your camera.
- **Capture Mode → On Demand**: capture a snapshot when needed; this is the default.
- **Capture Mode → Live Feed**: continuously send recent frames during a call, so you can ask about what is visible now.

**On Demand can understand snapshots without a background Harness.** When you ask a visual question, a read-only Visual Analysis subagent inspects one snapshot and returns evidence for Omni to answer. Its status and result appear in Subagents, where it can be stopped. Ending the call cancels unfinished analyses. It uses the same model, API key, and region as the main conversation; no extra model configuration is needed.

Screen Live Feed, On Demand, and visual monitors capture the full selected display, not just the foreground window. With multiple displays, choose one under **Display**; the default follows the primary display. On Demand sends the snapshot to the visual helper and its text analysis to main Omni, not the image pixels directly. If analysis fails, no visual contents are confirmed; an empty metadata field does not mean a blank desktop. File and app operations still need a background Harness.

### Frame rate and resolution

The default Live Feed is **1 frame per second at 1280 × 720 (720p)**. Increasing frame rate or resolution increases network and model usage and does not guarantee that your device can keep up.

For example, to explicitly use 1 FPS and 720p:

```json
{
  "visualInput": {
    "fps": 1,
    "liveResolution": { "width": 1280, "height": 720 },
    "cameraResolution": { "width": 1280, "height": 720 }
  }
}
```

| Setting                        | Purpose                                            | Default                                               |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------- |
| `visualInput.source`           | Screen or camera at startup                        | `"screen"`; use `"camera"` for the camera             |
| `visualInput.mode`             | On-demand snapshots or continuous input at startup | `"on-demand"`; use `"live-feed"` for continuous input |
| `visualInput.fps`              | Live Feed frames per second                        | `1`; range `0.1`–`10`                                 |
| `visualInput.liveResolution`   | Target resolution for live frames                  | `1280 × 720`                                          |
| `visualInput.cameraResolution` | Camera preview and video stream resolution         | `1280 × 720`                                          |

Enter sizes as width × height. The original aspect ratio is preserved. Frames may be compressed or resized before transmission, so a larger configured size does not necessarily reveal more detail.

### Screen and camera snapshot sizes

On-demand snapshots have two independent settings. Both default to the native size available from the device:

- `snapshotResolution`: screen snapshot size.
- `cameraSnapshotResolution`: camera snapshot size.

For example, keep native screen snapshots and limit camera snapshots to 1920 × 1080:

```json
{
  "visualInput": {
    "snapshotResolution": "native",
    "cameraSnapshotResolution": { "width": 1920, "height": 1080 }
  }
}
```

This does not change the camera preview or Live Feed resolution. `native` is supported only by these two snapshot settings.

### Camera preview and permissions

Selecting Camera shows a preview by default. Its eye button only shows or hides the preview: **hiding it does not turn off camera input**. A local preview may remain after a call ends; switch to Screen or quit Host to close the camera flow.

Grant the permissions requested for your current source. Camera does not require screen permission first. Screen Live Feed and on-demand screen snapshots both require Screen Recording, not Accessibility.

## Memory: retain useful context

Memory is enabled by default; visual memory is disabled by default. In **Settings → Personalization → Memory**, you can:

- Enable or disable Memory without deleting previously saved content.
- Select or create libraries for work, personal use, or different projects.
- Rename a library.
- Change the memory updater model.
- Enable or disable **Visual memory**.

End the call before switching or creating a library, or changing the updater model. Renaming and toggling Memory are available during a call.

### Change the updater model

The updater extracts information worth keeping. It is configured separately from the main Realtime model. Its default is `qwen3.7-plus`; use a model ID available in your selected region.

```json
{
  "memory": {
    "enabled": true,
    "updater": { "model": "qwen3.7-plus" }
  }
}
```

To disable Memory, set `memory.enabled` to `false` or use Settings.

### Enable visual memory

Visual memory periodically observes the selected screen or camera and saves a text description. The default interval is 60 seconds:

```json
{
  "memory": {
    "observer": {
      "enabled": true,
      "intervalSec": 60
    }
  }
}
```

The observer uses the updater model unless configured separately. It needs image input support; if your updater is text-only, set `memory.observer.model` to a suitable model.

Visual memory is separate from answering questions about the current view. Use On Demand for a single snapshot analyzed by the visual helper, or Live Feed for continuous frames. Neither requires enabling visual memory.

### Where memories are stored

The default directory is `~/.qwen-live-harness/memories/`. Normally, select a library in the UI rather than editing its folder.

To store new data elsewhere:

```json
{
  "memory": {
    "dir": "~/Documents/QwenMemories"
  }
}
```

Changing the directory does not move existing memories. Quit the app and back up the original directory before migrating data. Memory primarily stores text, not raw audio or video in its database. Visual memory still sends sampled images to the observer model to generate descriptions.

## Proactive: reminders and observation

Proactive is enabled by default. For example, ask:

- “Remind me to take a break in ten minutes.”
- “Watch the screen and tell me when the download finishes.”
- “Watch the camera and let me know if something changes.”

Observation starts only after you create a monitor or reminder task. A Monitor does not open websites or periodically fetch a URL; it can observe a page **already visible on the screen**.

If the model is speaking, proactive notifications wait and play in order after it finishes. Ending the call stops that call's Proactive monitors and reminders, unlike background Harness tasks that may continue.

### When an announcement is not heard

If a Proactive response finishes normally without generating speech, Live can try one independent announcement using the same model and voice. It reads the Monitor's observation summary, not the raw media again; no extra model setting is needed. This adds one model call, not another monitoring trigger.

In Subagents, **Preparing announcement** means a response is still being prepared; **Announcing** starts only after the device confirms playback start. The independent fallback is **Announcement delivered** only after playback completion, or **Not announced** if it was not fully delivered. A one-shot can therefore be completed while its announcement is undelivered; a repeat monitor continues after this fallback fails.

The helper has a 20-second generation timeout and follows the announcement deadline. A queued fallback waits for earlier replies or receipt processing; user speech, output mute, cancellation, or End call discards it. Interrupted fallback generation/playback is not replayed. Muting the primary path consumes the notification without replaying it on unmute: a completed event while muted does not mean you heard it.

### Common Proactive settings

```json
{
  "proactive": {
    "enabled": true,
    "monitor": { "representationCompact": "normal" },
    "scheduler": { "evalIntervalSec": 1 },
    "vision": { "windowSizeSec": 10 },
    "audio": { "windowSizeSec": 60 }
  }
}
```

| Setting                                   | Default    | Meaning                                                                                                    |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `proactive.enabled`                       | `true`     | Enable observation and reminders                                                                           |
| `proactive.monitor.representationCompact` | `"normal"` | Video representation compression: `normal` aggregates representations; `none` retains finer-grained detail |
| `proactive.scheduler.evalIntervalSec`     | `1`        | Seconds between checks for a complete new chunk                                                            |
| `proactive.vision.windowSizeSec`          | `10`       | Maximum seconds of recent frames buffered locally                                                          |
| `proactive.audio.windowSizeSec`           | `60`       | Maximum seconds of recent audio buffered locally                                                           |

Monitor media cadence is **fixed at 1 FPS and two-second chunks**, independently of the configurable foreground Live Feed frame rate. Sampling, network, inference, and playback introduce delay; not every frame immediately produces a notification.

Each Monitor round covers **two seconds**. Audio-only monitoring sends two seconds of new microphone audio. Visual monitoring samples **one new frame per second**, giving two frames per round; combined monitoring pairs them with the same two seconds of microphone audio. Video-only monitoring uses a silent audio track for the API protocol, not microphone sound. The next chunk is sent after the Monitor answers. Earlier answers remain in the same model session; they are not repeatedly resent. `windowSizeSec` is a local buffer limit, not the amount resent each round or a limit on the server's conversation history.

The Monitor frame rate and chunk duration are not configuration options. You can adjust buffering, scheduling, cooldown, and visual compression. Both `windowSizeSec` values must be at least two seconds. A visual or combined chunk needs two new frames from the same time span; slow capture can cause incomplete chunks to be skipped. Debug logs record why, and previously captured frames are not duplicated to fill gaps.

This compression setting applies only to Proactive visual monitors, not foreground Live Feed or snapshot resolution. `normal` suits overall visual changes; try `none` for fine text or small details. On Demand Visual Analysis uses its own fixed `normal` setting. Restart Qwen Live Harness after editing it. Initialization does not ask about this option.

## Do you need a background Harness?

You can use conversation, live visual input, Memory, and Proactive without installing a coding agent. Select **Continue without a background Harness** during initialization.

To edit files, run commands, or perform background work, first install and sign in to an agent using its official guide, then select it during initialization. Supported options include [Qwen Code](https://github.com/QwenLM/qwen-code), [Qoder CLI](https://qoder.com/cli), [Codex](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup), and [Gemini CLI](https://github.com/google-gemini/gemini-cli).

To explicitly disable background delegation in an existing configuration:

```json
{
  "backends": []
}
```

Keep the empty array. Omitting `backends` selects the default local Qwen Serve connection instead of disabling delegation.

### Web search

With or without a background Harness, a search subagent can look up public information. No separate search model is needed: it uses the main conversation's complete model ID, including any invitation-only alias, endpoint, and API key. Live does not maintain a model-name allowlist; native search availability depends on the service.

Qwen Omni briefly acknowledges a lookup, then searches in the background. You can continue talking or request other independent searches. Searches run concurrently; ready results wait for the current speech and playback to finish, then are answered in order. Conversation that does not need current information is answered directly.

If search fails, including when the service rejects native search, a configured background Harness takes over the same read-only query. Without a background Harness, Live reports the failure. This handoff does not reuse or interrupt another working session and does not approve permissions for you.

Use **Subagents → Web Search** to inspect the query, status, and result, or stop a search. A successful fallback also creates a separate background task entry. Ending the call cancels the searches and their automatic fallback tasks, but not unrelated background jobs. If a backend has not confirmed cancellation, use the task panel's actual status.

Use **Subagents** to inspect tasks, stop them, or respond to permissions. Closing details does not stop a task. If a backend reports a file-permission error without offering an approval button, check the coding agent's own configuration: Live can only display permission requests the agent actually sends.

## Which UI choices are saved?

- **Video Source / Capture Mode** take effect immediately but are not written to the configuration. Edit `visualInput.source` / `mode` to change the next startup's defaults.
- Confirmed **Display, Language, and Memory** settings are saved.
- The local Host saves microphone selection, theme, and window positions.
- Manual configuration-file edits require a full quit and restart.

## Troubleshooting

**My configuration change did not take effect.** Save the file and fully restart. Environment variables override the file; for example, `QWEN_LIVE_HARNESS_REALTIME_ENDPOINT` overrides its region endpoint.

**My API key or model is unavailable.** Check that the key and endpoint belong to the same region and that you entered a complete model ID available there.

**Realtime reports a quota limit.** Check the selected region's account quota and concurrent sessions in the provider console. Ending unused sessions may free concurrency, but an exhausted account quota needs provider-side action; repeated restarts do not resolve it.

**There is no sound, or startup is stuck.** Check microphone permission, select a working device under Settings → Sound → Microphone, then click Start to retry. Avoid repeatedly clicking while an operation is timing out.

**Music sounds worse after enabling a Bluetooth headset microphone.** Choose the built-in or a separate microphone under Sound → Microphone while keeping the headset for playback. Model output uses 24 kHz PCM; the 16 kHz setting is for microphone input. Host resamples playback to the output device's actual rate. Changing the software sample rate cannot prevent the headset from switching to its lower-quality call profile.

**I only want to end the interaction.** Use End call or `Command+E`. This also stops the call's visual analyses, Proactive monitors, searches, and their automatic fallback tasks. Use Quit to exit the entire application, or `Ctrl+C` when launched from a terminal.

### Get more diagnostic information

```sh
qwen-live-harness --debug
```

From source, run in the repository root:

```sh
npm start -- --debug
```

Debug mode prints more runtime information and creates a run archive under `<dataDir>/debug/run-*` (by default `~/.qwen-live-harness/debug/run-*`). Its log entry shows the exact directory. The archive connects model requests/responses, tool and runtime events, and the audio/images actually handled by the recorded paths. It is not a continuous device recording, and media from runs without debug cannot be recovered afterward.

The **10 most recent finished runs** are retained, with a **512 MiB budget per run**. Active runs are protected, so more than ten directories can temporarily exist. Storage limits, dropped records, missing files, or write failures can make a capture incomplete; check `manifest.json` and the warning logs before treating it as a complete record. These diagnostic failures must not stop the interaction.

Per-Monitor archives are stored separately in `qwen-live-harness-monitor-debug/` under the system temporary directory; logs show the exact location. The **10 most recently created monitors** are retained across all modalities. This does not mean only 10 requests or a fixed disk-space limit. For per-round analysis, see [Monitor diagnostic archives](../packages/qwen-live-harness/README.md#monitor-diagnostic-archives).

Debug archives can contain private voices, screen/camera images, prompts, Memory context, tool arguments/results, and conversation text. Known credentials are redacted, but that does not anonymize personal content or secrets inside media. Inspect files before sharing; do not upload your entire data directory. Disable debug when you finish troubleshooting.

For offline verification and exporting a selected model connection, see [Run archives and offline inspection](../packages/qwen-live-harness/README.md#run-archives-and-offline-inspection). The helper does not call an API or execute recorded tasks; it cannot guarantee an identical future model response.

For source development, see the [Daemon development guide](../packages/qwen-live-harness/README.md). For custom backends, environment variables, Memory retrieval parameters, and other advanced settings, see [Advanced configuration](../packages/qwen-live-harness/README.md#advanced-configuration).
