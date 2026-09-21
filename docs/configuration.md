# Configuration and Features

[简体中文](configuration_ZH.md) | English

[Home](../README.md) · [Advanced configuration for developers](../packages/qwen-live-harness/README.md#advanced-configuration)

After setup, most everyday options are available in **Settings** on the voice card. Open the configuration file to change a model, API key, image resolution, or other advanced option.

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
| Choose how background requests are approved        | Settings → Background Harness permissions          |
| Change a model, API key, resolution, or frame rate | Settings → Open configuration                      |
| Start or end a call                                | Start call / End call, or `Command+E`              |

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

Supported values are `iris`, `clay`, `sage`, `tide`, `graphite`, `rose`, and `berry`. If you edit the file manually, reopen the desktop app or reconnect to the background service to apply it; changing the palette in Settings needs no restart. Missing or invalid values use Iris. Light, dark, and system appearance are separate settings under **Personalization → Appearance**.

## Visual input

Choose **what to see**, then **when to see it**:

- **Video Source → Screen**: use your computer screen.
- **Video Source → Camera**: use your camera.
- **Capture Mode → On Demand**: capture a snapshot when needed; this is the default.
- **Capture Mode → Live Feed**: continuously send recent frames during a call, so you can ask about what is visible now.

**On Demand does not require a coding agent.** A Visual Analysis subagent analyzes a snapshot and announces the answer; you can continue asking about its text result. It reuses your main model, key, and region. View or stop it in **Subagents**; ending the call cancels unfinished analyses. Selected temporary failures are retried once using the same image, without taking another screenshot.

Screen Live Feed, On Demand, and visual monitors capture the **full selected display**, not just the foreground window. Choose a display under **Display**; the default is the primary display. File and app operations still require a coding agent. For model routing and retry details, see [Audio and visual input](../packages/qwen-live-harness/README.md#audio-and-visual-input).

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

Selecting Camera shows a preview by default. Its eye button only shows or hides the preview: **hiding it does not turn off camera input**. A local preview may remain after a call ends; switch to Screen or quit the app to close the camera.

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

Check the announcement status in **Subagents**, not just whether the task is completed. A response with no audio may get one extra speech attempt using the same model and voice. Speaking, muting output, cancelling the task, or ending the call can interrupt it; interrupted or muted announcements are not replayed automatically. A completed task does not necessarily mean its notification was heard. See [announcement behavior](../packages/qwen-live-harness/README.md#proactive-announcement-fallback) for developer details.

### Common Proactive settings

```json
{
  "proactive": {
    "enabled": true,
    "monitor": { "representationCompact": "normal" }
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

Monitor input is **fixed at 1 FPS and two-second chunks**, independently of foreground Live Feed. Do not add Monitor FPS or chunk-duration fields to the file. Buffer windows must be at least two seconds; they limit locally waiting media, not model conversation history. Sampling, network, and inference cause delay, and incomplete chunks may be skipped.

`normal` compression suits overall visual changes; try `none` for small text or detail. It affects only Proactive visual monitors, not Live Feed or snapshots. Restart after editing. For cooldown and other advanced settings, see [Proactive tuning](../packages/qwen-live-harness/README.md#proactive-tuning).

## Do you need a background Harness?

You can talk, share images, and use Memory and Proactive without installing a coding agent. Select **Continue without a coding agent** during setup.

To edit files, run commands, or perform background work, first install and sign in to an agent using its official guide, then select it during initialization. Supported options include [Qwen Code](https://github.com/QwenLM/qwen-code), [Qoder CLI](https://qoder.com/cli), [Codex](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup), and [Gemini CLI](https://github.com/google-gemini/gemini-cli).

To explicitly disable background delegation in an existing configuration:

```json
{
  "backends": []
}
```

Keep the empty array. Omitting `backends` selects the default local Qwen Serve connection instead of disabling delegation.

### Web search

With or without a coding agent, a search subagent can look up public information. It uses the main conversation's complete model ID, including any invitation-only alias, endpoint, and API key; no separate search model is needed. The app does not restrict search by model name. Native search availability depends on the service.

Qwen Omni acknowledges a lookup, then searches in the background while you continue talking. Independent searches can run concurrently, and their answers wait until current speech finishes. Text results remain available for follow-up questions and in **Subagents**; interrupted announcements are not replayed automatically. Ordinary conversation does not need a search.

If search fails, including when the service does not support native search, a configured coding agent takes over the same read-only query. Without one, the app reports the failure. The handoff uses a separate task without interrupting other work; its permission requests follow your selected global permission mode.

Use **Subagents → Web Search** to inspect the query, status, and result, or stop a search. A successful fallback also creates a separate background task entry. Ending the call cancels the searches and their automatic fallback tasks, but not unrelated background jobs. If a backend has not confirmed cancellation, use the task panel's actual status.

Use **Subagents** to inspect tasks, stop them, or respond to permissions. Closing details does not stop a task. If a backend reports a file-permission error without offering an approval button, check the coding agent's own configuration: Live can only display permission requests the agent actually sends.

### Permission choices in Subagents

After configuring a background Harness, `init` asks how to handle its permission requests. You can change the choice later under **Settings → Background Harness permissions**, or edit the top-level `permissionMode` field in `config.json`:

- **Ask every time** (`"ask"`, default): review the command, arguments, working folder, and affected files in Subagents, then allow or deny the current operation. There is no per-request “always allow” choice.
- **Allow all by default** (`"allow-all"`): automatically approve currently waiting and future requests. Important operations are announced during calls; simple checks such as `pwd`, `ls`, and `git status` are recorded without speech. Requests can still be processed when no call is active, without starting audio.

Every approval uses a one-time backend option, not a persistent backend grant. If no such option is available, Live cancels and explains why. An automatic-approval announcement confirms approval, not that the command has started or finished. Switching back to **Ask every time** stops future automatic approvals, but does not undo approvals already issued. Backend restrictions still apply, and Live only handles requests the backend actually sends.

Permissions already granted in a coding agent's own settings must be revoked there. See [Spoken permissions and global approval mode](../packages/qwen-live-harness/README.md#spoken-permissions-and-global-approval-mode) for developer details and legacy configuration behavior.

## Which UI choices are saved?

- **Video Source / Capture Mode** take effect immediately but are not written to the configuration. Edit `visualInput.source` / `mode` to change the next startup's defaults.
- Confirmed **Display, Language, and Memory** settings are saved.
- **Background Harness permissions** are saved to `config.json` and apply immediately after Settings confirms success, including requests already waiting.
- The desktop app saves microphone selection, appearance, and window positions locally. The color palette is saved in `config.json`.
- Manual configuration-file edits require a full quit and restart.

## Troubleshooting

**My configuration change did not take effect.** Save the file and fully restart. Environment variables override the file; for example, `QWEN_LIVE_HARNESS_REALTIME_ENDPOINT` overrides its region endpoint.

**My API key or model is unavailable.** Check that the key and endpoint belong to the same region and that you entered a complete model ID available there.

**Realtime reports a quota limit.** Check the selected region's account quota and concurrent sessions in the provider console. Ending unused sessions may free concurrency, but an exhausted account quota needs provider-side action; repeated restarts do not resolve it.

**There is no sound, or startup is stuck.** Check microphone permission, select an available device under **Settings → Sound → Microphone**, then click **Start call**. Wait for the current attempt to finish or show an error before retrying.

**Music sounds worse after enabling a Bluetooth headset microphone.** Choose the built-in or a separate microphone under **Sound → Microphone** while keeping the headset for playback. Changing the software sample rate cannot prevent the headset from switching to its lower-quality call profile.

**I only want to end the call.** Use **End call** or `Command+E`. This also cancels the call's visual analyses, Proactive monitors, searches, and their fallback tasks. Use **Quit Qwen Live Harness** to exit the entire application, or `Ctrl+C` when launched from a terminal.

### Get more diagnostic information

```sh
qwen-live-harness --debug
```

From source, run in the repository root:

```sh
npm start -- --debug
```

Debug mode prints more information and saves requests, responses, and recorded media under `~/.qwen-live-harness/debug/run-*` by default. Logs show the actual directory. It retains the **10 most recent finished runs**, with a **512 MiB budget per run**; active runs are protected. Monitor media also has a separate temporary archive retaining the **10 newest monitors**, not just ten requests.

These are diagnostic records, not continuous recordings. Storage limits or write errors can leave them incomplete, and media from non-debug runs cannot be recovered afterward. See [Run archives and offline inspection](../packages/qwen-live-harness/README.md#run-archives-and-offline-inspection) and [Monitor diagnostic archives](../packages/qwen-live-harness/README.md#monitor-diagnostic-archives) to inspect or export selected evidence without calling an API or executing recorded tasks.

Debug archives can contain private voices, screen/camera images, prompts, Memory context, tool arguments/results, and conversation text. Known credentials are redacted, but that does not anonymize personal content or secrets inside media. Inspect files before sharing; do not upload your entire data directory. Disable debug when you finish troubleshooting.

For source development, see the [Daemon development guide](../packages/qwen-live-harness/README.md). For custom backends, environment variables, Memory retrieval parameters, and other advanced settings, see [Advanced configuration](../packages/qwen-live-harness/README.md#advanced-configuration).
