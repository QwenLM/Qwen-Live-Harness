# Qwen Live Harness Host 开发指南

简体中文 | [English](README.md)

[项目首页](../../README_ZH.md) · [配置与功能指南](../../docs/configuration_ZH.md) · [Daemon 开发指南](../qwen-live-harness/README_ZH.md)

Host 是 Qwen-Live-Harness 的 macOS 桌面端，负责 UI、系统权限、麦克风、扬声器、摄像头、屏幕采集和全局快捷键。主 Omni 会话、工具调度、后台 Harness、Memory 和 Proactive 由 daemon 管理；Host 不直接调用模型 API，也不包含 Node 或 daemon 的安装包。

本文面向修改桌面端的开发者。安装产品、选择输入源、设置记忆和配置参数请阅读[配置与功能指南](../../docs/configuration_ZH.md)。

## 开发环境

- macOS 12 或更高版本，支持 Apple Silicon 和 Intel。
- Node.js 22.13+；推荐使用仓库 `.nvmrc` 指定的 Node 22。
- Xcode Command Line Tools 或完整 Xcode，确保 `xcrun --find clang++` 和 `xcrun --show-sdk-path` 可用。
- Node 原生开发头文件，包含 `node_api.h`。构建脚本优先读取 `NODE_INCLUDE_DIR`，然后检查当前 Node 安装的 `include/node`、Homebrew 和 `/usr/local`。

Host 使用独立的 `package-lock.json` 和依赖树，需要单独安装依赖；根目录 `npm ci` 不会安装 Electron。原生 Appshot 由 Objective-C++ 编写，构建时生成 arm64/x64 通用 N-API 模块。构建过程见 [`scripts/build.mjs`](scripts/build.mjs)。

## 从源码启动

以下命令均在仓库根目录执行：

```sh
npm ci
npm --prefix packages/qwen-live-harness-host ci
npm run init
npm start
```

`npm run init` 构建 daemon 并进入源码初始化向导，写入配置；它不会下载安装或启动 Host，也不会更改已安装应用的桌面启动登记。已有配置可选择保留。

`npm start` 会依次构建 daemon 和 Host，启动本次 checkout 的 daemon，等待就绪后用本地 Electron 打开源码 Host。`Ctrl+C` 会清理它启动的两个进程。若已有 daemon 或 Host 正在运行，先退出再启动，避免混用发行版和源码实例。

同时查看两端调试日志：

```sh
npm start -- --debug
```

### 两个终端分别调试

需要独立重启某一端时，先完成上面的依赖安装和初始化，再在仓库根目录分别运行：

```sh
# 终端一：构建并启动 daemon，不打开已安装的 Host
npm run build
node packages/qwen-live-harness/dist/index.js --daemon-only --debug
```

```sh
# 终端二：构建并打开源码 Host
npm --prefix packages/qwen-live-harness-host start -- --live-harness-debug
```

`--daemon-only` 属于 daemon 入口，不是根目录开发启动器的参数。直接运行 Host 时使用 `--live-harness-debug`，不要把 daemon 的 `--debug` 传给 Electron。

## 代码分工

| 入口                                                             | 职责                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| [`src/main/index.ts`](src/main/index.ts)                         | Electron 生命周期、原生窗口、权限、自检、快捷键和 IPC 路由 |
| [`src/main/daemon-connection.ts`](src/main/daemon-connection.ts) | daemon 连接、v9 握手、音视频帧和状态同步                   |
| [`src/preload/index.ts`](src/preload/index.ts)                   | 受限的 renderer bridge，以及音频、摄像头引擎               |
| [`src/renderer/live-view.ts`](src/renderer/live-view.ts)         | 主界面、授权页、状态条；设置与子任务视图位于同目录         |
| [`src/native/appshot.mm`](src/native/appshot.mm)                 | 前台窗口截图、辅助功能文本与完整显示器采集                 |
| [`src/shared`](src/shared)                                       | 协议解析、IPC 类型、布局常量和主题                         |

主窗口和子任务窗口都启用 `contextIsolation`、renderer sandbox，关闭 `nodeIntegration`；导航和新窗口默认被拒绝。新增能力应通过明确的 preload API 和 IPC 消息接入，主进程校验发送窗口、字段、长度及通话 epoch，不能让 renderer 任意执行 Node 或访问文件。

### 布局与交互

几何参数统一维护在 [`overlay-geometry.ts`](src/shared/overlay-geometry.ts)，原生位置约束在 [`overlay-position.ts`](src/main/overlay-position.ts)。透明窗口画布与实际可见内容不是同一个边界：初始化页、主界面、预览和设置应分别按可见区域限位。

修改布局时检查贴边、多显示器、负坐标、缩放、显示器移除以及设置／预览展开。临时避让不能覆盖用户拖动保存的位置，状态刷新或截图不能重新定位窗口。媒体和编辑控件应保持挂载，避免字幕更新丢失焦点、预览或草稿。子任务面板由 [`subagents-windows.ts`](src/main/subagents-windows.ts) 管理，展开详情不能遮挡主界面和状态条。

Pebble UI 使用 234 × 194 px 交互卡片，包含常驻通话控件和任务摘要。设置显示在卡片旁，任务摘要打开任务窗口；终端会话、指令投递、会话报告、搜索、视觉分析和 Monitor 分别展示状态与详情。

默认主题为 Iris 雾紫。Host 在连接或重连时，从已认证 daemon 提供的配置路径读取顶层 `themeColor`，支持 `iris`、`clay`、`sage`、`tide`、`graphite`、`rose` 和 `berry`；缺省或非法值使用 Iris，不影响通话。浅色／深色／跟随系统独立持久化，见[配置指南](../../docs/configuration_ZH.md#主题配色)。

## 与 daemon 的边界

Host 通过 loopback WebSocket `/live/host` 连接 daemon。默认发现文件为 `~/.qwen-live-harness/run/daemon.json`，权限为 `0600`，包含实例 PID、nonce 和连接凭据。不要将文件内容写入诊断或公开分享。

协议当前为 **v9**，两端定义分别位于：

- Host：[`src/shared/protocol.ts`](src/shared/protocol.ts)。
- Daemon：[`src/host/types.ts`](../qwen-live-harness/src/host/types.ts) 与 [`qwen-live-harness-host-coordinator.ts`](../qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts)。

修改消息需要同时检查两端解析和能力协商。媒体和会话操作不能串入已结束的 epoch，进程级控制绑定 daemon 实例 nonce；播放回执还需匹配 output ID。主模型的名称、API key、会话配置和工具响应都由 daemon 持有，Host 只提交设备输入并播放返回结果，不直接创建 Realtime response 或提交模型音频缓冲。

已安装应用通过 `run/runtime.json` 中登记的 Node、CLI 和工作目录按需启动 daemon，使用内部 `--daemon-only` 避免循环拉起。普通断线只重连，不无限重启进程。CLI 打开的 Host 会接收对应的 discovery 路径和 owner 身份；停止该 daemon 时，Host 根据匹配实例的退出通知收尾。

`End call` 结束交互，保留桌面界面；`Quit Host` 协调关闭整套应用，清理未确认时保留错误和重试入口。实例身份、启动与退出逻辑见 [`daemon-bootstrap.ts`](src/main/daemon-bootstrap.ts)、[`daemon-lifecycle.ts`](src/main/daemon-lifecycle.ts)。发行版 CLI 与 Host 必须版本配套，协议号相同不代表不同版本可混用。

## 设备与权限

| 当前视觉模式       | 所需 macOS 权限  |
| ------------------ | ---------------- |
| Screen + On Demand | 麦克风、屏幕录制 |
| Screen + Live Feed | 麦克风、屏幕录制 |
| Camera             | 麦克风、摄像头   |

未选中来源的权限不应阻止交互。默认快捷键 `Command+E` 使用 Electron `globalShortcut`，不需要 Input Monitoring。开发 Electron 与正式应用的系统授权分别由 macOS 管理，应在实际运行的应用身份上验证。

Appshot 是随 Host 构建的内置模块，不依赖外部截图 App、CLI、MCP 或运行时下载。Screen On Demand、Live Feed 和视觉 Proactive monitor 都捕获选定显示器的完整画面，并排除 Host 自身窗口。On Demand 保存原生 PNG 资产，编码后的截图遵循分辨率配置及传输上限；完整显示器采集不要求辅助功能权限。Camera 使用同一设备引擎提供预览、实时帧和单次照片；隐藏预览只改变显示，不代表停止采集。

daemon 将 On Demand 截图交给只读视觉分析子模型，再把文字证据交回主对话；Host 在 Subagents 中展示进度和结果，不直接调用模型。Live Feed 和 Proactive 使用各自的输入通路。具体 Source、Mode、分辨率与能力边界见[配置指南](../../docs/configuration_ZH.md)。

采集尺寸与协议上限分开校验：实时帧目前最多 `1920 × 1080`、每帧 `190 KiB`，截图资产上限为 `8 MiB`。配置允许更大的采集目标，不代表实时传输会保留同样的像素数。Camera 原生截图优先使用静态拍照能力，否则尝试视频约束回退；不支持时应明确失败。修改尺寸或编码策略时，同时检查 [`camera-engine.ts`](src/preload/camera-engine.ts)、[`appshot-capture.ts`](src/main/appshot-capture.ts) 和共享协议限制。

### 音频与故障恢复

麦克风通过 AudioWorklet 转为单声道 16-bit、16 kHz PCM。daemon 请求模型输出 **24 kHz PCM**，Host 按同一采样率解码。播放 AudioContext 使用输出设备自身的采样率，不强制切换系统设备时钟。协商了结束标记的连接采用连续流式重采样，并等待对应输出真正播放完毕。修改时保持帧顺序、output ID 和播放完成回执一致。

播放使用 **10 ms 调度余量**并保持 PCM 流的播放速度；已排队分片始终连续衔接，不会每片再等 10 ms。停止或静音立即清理待播音频。模型准备响应、向设备转交音频、设备实际播放是不同状态；通知送达需要对应的播放回执。

蓝牙耳机启用自身麦克风时，macOS 可能进入免提模式；这与模型输出采样率不同。测试应同时覆盖内置／USB 麦克风与蓝牙输出，不能通过强制设备采样率解决系统路由问题。

录音启动、设备切换和音频恢复使用有界等待。主进程在 10 秒内等待设备 ready 与首个输入帧；静音只需 ready。AudioContext 关闭最多等待 1 秒。Stop、静音、通话切换和退出会取消过时操作，迟到的媒体流与 AudioContext 必须释放，取消不能伪造就绪或报成新的播放错误。

音频超时停止本轮通话并保留 UI、设置、拖拽和 Quit，不立即循环重试。用户可选择输入设备并按 Start／`Command+E` 重试。技术音频故障不撤销系统授权；真正缺少权限时，授权提示优先于音频错误。对应实现见 [`capture-readiness.ts`](src/main/capture-readiness.ts)、[`audio-operation.ts`](src/preload/audio-operation.ts) 和 [`audio-engine.ts`](src/preload/audio-engine.ts)。

## 日志与文案

Host 偏好和常态故障日志位于 Electron `userData`，默认路径为：

```text
~/Library/Application Support/qwen-live-harness-host/
├── overlay-position.json
├── language.json
├── theme.json
└── logs/
    ├── host-errors.log
    └── host-errors.log.1
```

未开启 debug 时也会记录精选故障事件。日志仅包含白名单错误码、阶段、epoch 等元信息，文件权限为 `0600`；每份上限 1 MiB，最多保留当前文件与一份轮转。日志写入失败不能中断音视频或退出流程，见 [`host-diagnostics.ts`](src/main/host-diagnostics.ts)。

`--live-harness-debug` 记录 Host 状态、设备和帧传输诊断。daemon 的 `--debug` 在 `<dataDir>/debug/run-*` 归档主模型、Monitor、搜索、视觉分析、通知播报五类连接，以及运行／控制事件，包含私密 Prompt、Memory 上下文、工具和媒体；凭据脱敏不能去除音视频里的秘密。逐 Monitor 媒体归档独立保存。无需执行记录中的任务即可检查／导出归档，见[运行归档与离线检查](../qwen-live-harness/README_ZH.md#运行归档与离线检查)；普通用户的诊断开关与数据路径见[配置指南](../../docs/configuration_ZH.md)。

固定展示文本统一放在 [`packages/qwen-live-harness/src/i18n/messages.ts`](../qwen-live-harness/src/i18n/messages.ts)，每个键包含 `en` 与 `zh-CN`。Host 构建通过别名编入共用的文案、启动和子任务模块，不在运行时依赖已安装的 daemon npm 包。修改共用文件后应重建并验证两个包。

## 测试与打包

在仓库根目录运行 Host 检查：

```sh
npm --prefix packages/qwen-live-harness-host run typecheck
npm --prefix packages/qwen-live-harness-host test
npm run build:host
```

修改协议、共享文案或生命周期时，也运行 daemon 的相关测试和根目录类型检查。自动测试覆盖协议、布局、媒体时钟、超时与退出；真实设备、权限弹窗、拖拽和签名安装仍需在 macOS 验证，并在 PR 中注明验证环境。

生成本地安装包，不发布到 GitHub 或 npm：

```sh
npm --prefix packages/qwen-live-harness-host run dist:mac:no-publish
```

编译产物在 `dist/`，安装包在 `release/`。打包配置见 [`electron-builder.yml`](electron-builder.yml)：App ID 为 `com.alibaba.qwen-live-harness.host`，产品名为 `Qwen Live Harness Host`，正式安装路径为 `/Applications/Qwen Live Harness Host.app`。原生模块作为独立 resource 随应用签名；保留 ASAR 完整性和 Electron fuse 限制。仅构建成功不能代替正式签名与公证验证。

### 发布维护

发布入口是 [Qwen Live Harness Host Release](../../.github/workflows/qwen-live-harness-host-release.yml)。推送 `main` 运行 CI；相关 PR 做打包 dry run，正式发布需从 `main` 手动触发。发布版本必须与 daemon、Host 的已提交版本一致，并同步相应 lock 文件；公开 release 和 npm 版本不可覆盖，`clobber` 仅用于尚未公开的 draft。

稳定版流程依次完成构建／测试、Developer ID 签名与公证、GitHub Release、OSS 镜像，再发布 npm 包。产物包含 arm64/x64 的 ZIP、DMG、`Qwen-Live-Harness-Host-manifest.json` 和校验文件；tag 为 `qwen-live-harness-host-vX.Y.Z`，稳定下载 feed 为 `qwen-live-harness-host-latest`。draft 不发布 npm；prerelease 使用 npm `preview` 标签，不更新稳定 Host feed。

正式安装器验证版本、manifest、SHA-256、bundle ID、Developer ID team `NF4574S59H`、`codesign --deep --strict` 和 Gatekeeper。维护签名时核对 [`build/entitlements.mac.plist`](build/entitlements.mac.plist)，不要扩大 renderer 权限或绕过这些检查。

[OSS 同步 workflow](../../.github/workflows/sync-qwen-live-harness-host-to-oss.yml) 使用 `ossutil` 上传版本化 ZIP 和 manifest，公开下载校验成功后再更新 `latest` manifest。默认地址为 `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/qwen-live-harness-host`；安装器优先 OSS，再回退本仓库 GitHub feed。OSS 可单独重传；GitHub fallback 需要仓库和 Release 对下载者可访问。

维护者需要配置：

- Apple 签名与公证凭据：workflow 支持 `APPLE_CERTIFICATE`／`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_ISSUER`／`APPLE_API_KEY`／`APPLE_API_KEY_P8` 和 `APPLE_TEAM_ID`；替代变量与编码格式以 workflow 为准。
- OSS 上传凭据：`ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET`，以及 `production-release` environment；可选 bucket、endpoint、公开地址变量见同步 workflow。
- npm [Trusted Publisher](https://docs.npmjs.com/trusted-publishers)：绑定 `QwenLM/Qwen-Live-Harness`、workflow 文件名 `qwen-live-harness-host-release.yml` 和 environment `production-release`。发布 job 使用 `id-token: write` 的 OIDC，不读取 `NPM_TOKEN`；公开仓库发布附带 provenance。当前 workflow 固定支持 Trusted Publishing 的 Node/npm 版本。

## 许可证

[Apache License 2.0](../../LICENSE)。
