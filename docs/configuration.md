# 配置与功能指南

简体中文 | [English](configuration_EN.md)

[返回项目首页](../README.md) · [开发者高级配置](../packages/qwen-live-harness/README.md#高级配置参考)

完成初始化后，大部分日常操作都可以在悬浮球的 **Settings / 设置** 中完成。只有修改模型、API key、画面清晰度等参数时，才需要打开配置文件。

## 想改什么，去哪里改

| 我想……                           | 在哪里操作                                |
| -------------------------------- | ----------------------------------------- |
| 换一个麦克风                     | Settings → Audio Source                   |
| 在屏幕和摄像头之间切换           | Settings → Video Source                   |
| 让模型持续看画面                 | Settings → Capture Mode → Live Feed       |
| 选择要看的显示器                 | Settings → Video Source → Display         |
| 开关记忆、换记忆库、修改记忆名字 | Settings → Memory                         |
| 切换中文／英文、浅色／深色       | Settings 最下方的 Language / Theme        |
| 修改模型、API key、分辨率、帧率  | Settings → Open config.json ↗             |
| 开始或结束交互                   | 小球上的 Start / End call，或 `Command+E` |

## 修改配置，只需五步

1. **打开文件。** 在 Settings 点击 **Open config.json ↗**，会用电脑默认的编辑器打开配置。
2. **留一份备份。** 第一次修改前，把文件复制一份，例如 `config.backup.json`。
3. **只改需要的字段。** 按下文示例找到同名设置，保留文件里的其他内容。
4. **保存文件。** 配置使用 JSON：文字加双引号，不写注释，最后一项后面不要留逗号。
5. **退出并重启。** 完整退出 Qwen Live Harness 后重新打开；仅点击 End call 不会重新读取整个配置。

默认文件在 `~/.qwen-live-harness/config.json`。如果曾设置其他配置目录，Settings 会打开当前实际使用的文件，不必自己寻找路径。

无法打开 Settings 时，也可以在 Finder 的“前往文件夹”中输入 `~/.qwen-live-harness`，再用文本编辑器打开 `config.json`。配置可能含有 API key，分享副本前请先隐去密钥。

下文的 JSON 都是**要合并到现有文件的片段**，不是让你用片段覆盖整个文件。例如，已经有 `memory` 时，在它里面修改对应内容，不要再添加第二个 `memory`。

重新运行初始化并确认覆盖会重新生成配置。只是想调整一两个选项时，直接编辑更方便，也更容易保留已有设置。

## 模型、API key 与服务地域

第一次配置，推荐使用初始化向导：

```sh
qwen-live-harness init
```

向导会询问 API key、Realtime 模型名和服务地域。地域可用左右方向键切换，回车确认；默认选择北京。

| 使用哪个地域 | 在向导中选择               |
| ------------ | -------------------------- |
| 中国内地服务 | Beijing / 北京（国内）     |
| 国际服务     | Singapore / 新加坡（国际） |

北京和新加坡的 API key **不能混用**。请在所选地域创建 key，并确认该地域可以使用你选择的模型。获取方式见[官方 API key 指南](https://help.aliyun.com/zh/model-studio/get-api-key)。

向导会自动填写所选地域的服务地址，不必手动拼写。

<details>
<summary>如果只想在配置文件里切换地域</summary>

同时修改 `realtimeApiKey` 和 `realtimeEndpoint`，其他设置可以保持不变：

| 地域   | `realtimeEndpoint` 填什么                              |
| ------ | ------------------------------------------------------ |
| 北京   | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`      |
| 新加坡 | `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime` |

</details>

仅更换同一地域的 API key 或模型时，可以在现有文件中修改：

```json
{
  "realtimeApiKey": "sk-your-api-key",
  "realtimeModel": "qwen3.5-omni-plus-realtime"
}
```

当前默认主模型是 `qwen3.5-omni-plus-realtime`。使用其他模型时，把控制台提供的**完整 Realtime 模型 ID** 填入 `realtimeModel`，不要直接填写产品宣传名称。

### 常用设置速查

| 字段               | 默认或常见值                   | 什么时候需要改                               |
| ------------------ | ------------------------------ | -------------------------------------------- |
| `language`         | `"zh-CN"` 或 `"en"`            | 修改固定界面语言；更推荐直接在 Settings 切换 |
| `realtimeApiKey`   | 初始化时填写                   | 更换账号或服务地域                           |
| `realtimeModel`    | `"qwen3.5-omni-plus-realtime"` | 更换实时对话模型                             |
| `realtimeEndpoint` | 默认北京                       | 在北京／新加坡服务之间切换                   |
| `voice`            | `"Tina"`                       | 修改播报音色，需使用模型支持的名称           |
| `shortcut`         | `"Command+E"`                  | 修改开始／结束交互的快捷键                   |

Memory 和 Proactive 默认也使用所选地域的服务。通常不需要给它们分别设置 Endpoint。

## 视觉输入

先选“看哪里”，再选“什么时候看”：

- **Video Source → Screen**：看电脑屏幕。
- **Video Source → Camera**：看摄像头。
- **Capture Mode → On Demand**：需要时才截图，是默认模式。
- **Capture Mode → Live Feed**：通话期间持续发送近期画面，适合直接询问“你现在看见什么”。

**没有后台 Harness 时，想让 Omni 直接理解完整画面，建议用 Live Feed。** On Demand 可以提供一些屏幕文字，但完整截图通常需要后台 Harness 帮助分析；摄像头的按需截图也不能当成 Omni 已经看到了画面。

Screen 的 Live Feed 和视觉监控会看选定显示器的完整画面。On Demand 主要看当前前台窗口。使用多个显示器时，在 **Display** 里选择；默认跟随主显示器。

### 修改帧率和清晰度

默认是 **每秒 1 帧、1280 × 720（720p）**，一般可以先保持不变。提高帧率或分辨率会增加网络和模型用量，也不保证设备能达到设置的速度。

例如，明确使用 1 FPS、720p 的实时画面：

```json
{
  "visualInput": {
    "fps": 1,
    "liveResolution": { "width": 1280, "height": 720 },
    "cameraResolution": { "width": 1280, "height": 720 }
  }
}
```

| 设置                           | 作用                       | 默认值                              |
| ------------------------------ | -------------------------- | ----------------------------------- |
| `visualInput.source`           | 启动时使用屏幕还是摄像头   | `"screen"`；摄像头填 `"camera"`     |
| `visualInput.mode`             | 启动时按需截图还是实时画面 | `"on-demand"`；实时填 `"live-feed"` |
| `visualInput.fps`              | Live Feed 每秒发送几帧     | `1`，可设 `0.1`–`10`                |
| `visualInput.liveResolution`   | 实时画面的目标尺寸         | `1280 × 720`                        |
| `visualInput.cameraResolution` | 摄像头预览和实时视频流尺寸 | `1280 × 720`                        |

尺寸按“宽 × 高”填写，画面会保留原来的宽高比。实际发送时可能进一步压缩或缩小，因此设置更大尺寸不代表一定能看到更多细节。

### 屏幕截图和摄像头截图的尺寸

按需截图有两个独立设置，默认都用设备可提供的原生尺寸：

- `snapshotResolution`：Screen 截图尺寸。
- `cameraSnapshotResolution`：Camera 截图尺寸。

例如，屏幕截图保持原生尺寸，摄像头截图最多使用 1920 × 1080：

```json
{
  "visualInput": {
    "snapshotResolution": "native",
    "cameraSnapshotResolution": { "width": 1920, "height": 1080 }
  }
}
```

这不会同时改变摄像头预览或 Live Feed 的尺寸。`native` 只用于上述两个截图设置。

### 摄像头预览和权限

选择 Camera 后默认显示预览。小窗的眼睛按钮只控制显示／隐藏，**隐藏预览不等于关闭摄像头输入**。结束通话后可能仍保留本地预览；切回 Screen 或退出 Host 可关闭摄像头流程。

请按界面提示授予当前来源所需权限。Camera 不要求先授权屏幕；Screen 实时画面需要屏幕录制权限，按需截图还可能需要辅助功能权限。

## Memory：让对话有记忆

Memory 默认开启，视觉记忆默认关闭。最方便的入口是 **Settings → Memory**：

- 开关 Memory：关闭不会删除以前保存的内容。
- 选择或新建记忆库：适合区分工作、个人或不同项目。
- 修改记忆库名称。
- 修改记忆整理模型。
- 开关 **Visual memory / 视觉记忆**。

切换／新建记忆库或修改整理模型前，请先结束通话；改名和开关可以在通话中操作。

### 修改记忆整理模型

整理模型用来提炼值得保留的信息，和负责实时说话的主模型是两个设置。当前默认是 `qwen3.7-plus`，请使用所选地域可用的模型 ID。

```json
{
  "memory": {
    "enabled": true,
    "updater": { "model": "qwen3.7-plus" }
  }
}
```

如果只想关闭 Memory，把 `memory.enabled` 改成 `false`，或直接使用 Settings 开关。

### 开启视觉记忆

视觉记忆会定期观察所选的屏幕或摄像头，并保存文字描述。默认每 60 秒观察一次：

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

观察模型默认跟随记忆整理模型。它需要支持图片输入；如果整理模型只能处理文字，可另外设置 `memory.observer.model`。

视觉记忆和“当前对话是否持续看画面”是不同功能。想让 Omni 直接回答眼前的画面，仍请选择 Live Feed。

### 记忆保存在什么地方

默认目录是 `~/.qwen-live-harness/memories/`。通常在界面选择记忆库即可，无需修改文件夹。

需要另存到其他位置时，可以设置：

```json
{
  "memory": {
    "dir": "~/Documents/QwenMemories"
  }
}
```

改目录不会自动搬迁旧记忆。需要迁移时，请先退出应用并备份原目录。记忆以文字为主，不在记忆数据库中保存原始音视频；开启视觉记忆后，采样图片仍需发送给观察模型来生成描述。

## Proactive：主动提醒与观察

Proactive 默认开启。你可以直接说：

- “十分钟后提醒我休息。”
- “观察屏幕，下载完成后提醒我。”
- “看看摄像头里的变化，有新情况告诉我。”

它只会在你创建观察或提醒任务后开始工作。Monitor 不会自行打开网页或定期访问某个网址，但可以监测**屏幕上已经显示的网页**。

如果模型正在说话，主动通知会等待当前播报结束后依次播放。结束通话会停止这次通话中的 Proactive 观察和提醒；它与继续运行的后台 Harness 任务不同。

### 常用 Proactive 设置

```json
{
  "proactive": {
    "enabled": true,
    "scheduler": { "evalIntervalSec": 2 },
    "vision": { "fps": 1, "windowSizeSec": 10 },
    "audio": { "windowSizeSec": 60 }
  }
}
```

| 设置                                  | 默认值 | 通俗解释                     |
| ------------------------------------- | ------ | ---------------------------- |
| `proactive.enabled`                   | `true` | 是否开放主动观察和提醒功能   |
| `proactive.scheduler.evalIntervalSec` | `2`    | 每隔几秒检查一次是否需要判断 |
| `proactive.vision.fps`                | `1`    | 视觉 Monitor 的目标采样帧率  |
| `proactive.vision.windowSizeSec`      | `10`   | 一次判断参考最近几秒的画面   |
| `proactive.audio.windowSizeSec`       | `60`   | 一次判断参考最近几秒的声音   |

Monitor 帧率和前台 Live Feed 帧率是分别设置的，实际速度还受输入画面和设备影响。监控结果存在采样、网络和模型判断延迟，不是每一帧都会立刻触发提醒。

## 要不要接入后台 Harness

只想语音交流、看实时画面、使用 Memory 和 Proactive，可以不安装后台编程代理。初始化时选择 **暂不接入后台 Harness** 即可，不必研究代理配置。

希望 Live 修改文件、运行命令或完成后台工作时，先按代理的官方文档安装并登录，再运行初始化选择它。可选 [Qwen Code](https://github.com/QwenLM/qwen-code)、[Qoder CLI](https://qoder.com/cli)、[Codex](https://developers.openai.com/codex/cli)、[Claude Code](https://code.claude.com/docs/en/setup) 或 [Gemini CLI](https://github.com/google-gemini/gemini-cli)。

如果要在已有配置中明确关闭后台任务委托，可使用：

```json
{
  "backends": []
}
```

请保留这个空数组，不要直接删除 `backends` 字段：删除会启用旧的默认后端行为。

### 联网查询

有无后台 Harness，都可以通过搜索子智能体查询公开信息，无需单独配置搜索模型；它复用当前实时模型、API key 和服务地域。目前支持 `qwen3.5-omni-plus-realtime` 和 `qwen3.5-omni-flash-realtime`，其他模型不会自动获得原生搜索能力。

Qwen Omni 会先简短回应，例如“我查一下最新信息”，再在后台搜索。你可以继续对话或提出其他独立查询；多个搜索可并行进行，结果就绪后会等待当前讲话与播报结束，再依次回答。普通聊天、无需联网的问题仍直接回答。

如果搜索失败，已配置的后台 Harness 会自动接手同一个只读查询；没有后台时，会明确告知查询失败。转交不会复用或打断其他正在工作的后台会话，也不代替你批准权限。

在 **Subagents → Web Search / 联网搜索** 中可查看查询、状态和结果，或停止搜索。成功转交后会另外显示对应后台任务。结束通话会取消搜索及其自动转交的查询，其他后台任务不受影响；若后台尚未确认停止，按任务面板的实际状态判断。

任务可在 **Subagents / 子智能体** 中查看、停止或处理权限请求。关闭详情窗口不等于停止任务。若后台报“没有文件权限”却没有授权按钮，请检查编程代理自身的设置；Live 只显示代理真正发出的授权请求。

## 哪些界面设置会保存

- **Video Source / Capture Mode** 立即影响当前运行，但不会写入配置；想改变下次启动的默认值，请修改 `visualInput.source` / `mode`。
- **Display、Language、Memory** 的已确认设置会保存。
- 麦克风选择、主题和窗口位置由本机 Host 保存。
- 手动编辑配置文件后，都需要完整退出并重新启动。

## 常见问题

**改完配置没有生效？** 先确认保存了文件，并完整退出再启动。如果以前设置过环境变量，它会优先于配置文件，例如 `QWEN_LIVE_HARNESS_REALTIME_ENDPOINT` 会覆盖文件中的地域地址。

**提示 API key 或模型不可用？** 检查 key 和 Endpoint 是否属于同一地域，再确认填写的是该地域可用的完整模型 ID。

**没有声音或一直显示正在开始？** 检查麦克风权限，在 Audio Source 换一个有效设备，然后点击 Start 重试。超时后不要反复连续点击。

**蓝牙耳机打开麦克风后，音乐音质变差？** 可把 Audio Source 改成电脑内置或独立麦克风，继续用蓝牙耳机播放声音；调整软件采样率不能避免耳机切换通话模式。

**只想结束交互？** 点击 End call 或按 `Command+E`，本次搜索及其自动转交的查询也会停止。要完全退出，请使用 Quit；从终端启动时也可按 `Ctrl+C`。

### 需要更多日志时

```sh
qwen-live-harness --debug
```

Debug 可能额外保存 Monitor 的真实屏幕／摄像头画面、任务文字和音频；会话日志与记忆库也可能包含私人内容。分享前请检查，不要直接上传整个数据目录。

视觉 Monitor 的调试记录放在系统临时目录的 `qwen-live-harness-monitor-debug/` 下，日志会显示具体位置。仅保留最近创建的 10 个 Monitor 目录，但不代表总磁盘用量固定；问题排查完后建议关闭 debug。

源码启动、开发调试见 [Daemon 开发指南](../packages/qwen-live-harness/README.md)。如果需要自定义后端、完整环境变量列表、Memory 检索参数或其他高级选项，请查看[高级配置参考](../packages/qwen-live-harness/README.md#高级配置参考)。
