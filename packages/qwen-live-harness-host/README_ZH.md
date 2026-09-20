# Qwen Live Harness Host 开发指南

简体中文 | [English](README.md)

[项目首页](../../README_ZH.md) · [配置与功能指南](../../docs/configuration_ZH.md) · [Daemon 开发指南](../qwen-live-harness/README_ZH.md)

Host 是 Qwen-Live-Harness 的 macOS 桌面端，负责 UI、系统权限、音频采集与播放、摄像头和屏幕采集，以及全局快捷键。主 Omni 会话、工具调度、后台 Harness、Memory 和 Proactive 由后台服务（daemon）管理。Host 不直接调用模型 API，也不附带 Node.js 或 daemon 安装包。

本文面向桌面端开发者。安装、输入设备、记忆设置和配置文件的使用方法见[配置与功能指南](../../docs/configuration_ZH.md)。

## 开发环境

- macOS 12 或更高版本，支持 Apple Silicon 和 Intel。
- Node.js 22.13+；推荐使用仓库 `.nvmrc` 指定的 Node 22。
- Xcode Command Line Tools 或完整 Xcode，确保 `xcrun --find clang++` 和 `xcrun --show-sdk-path` 可用。
- 用于构建原生模块的 Node.js 头文件，包括 `node_api.h`。构建脚本优先检查 `NODE_INCLUDE_DIR`，然后检查当前 Node.js 安装的 `include/node`、Homebrew 和 `/usr/local`。

Host 使用独立的 `package-lock.json` 和依赖目录，需要单独安装依赖；根目录的 `npm ci` 不会安装 Electron。原生 Appshot 使用 Objective-C++ 编写，构建时生成兼容 arm64/x64 的通用 N-API 模块。构建过程见 [`scripts/build.mjs`](scripts/build.mjs)。

## 从源码启动

以下命令均在仓库根目录执行：

```sh
npm ci
npm --prefix packages/qwen-live-harness-host ci
npm run init
npm start
```

`npm run init` 构建 daemon 并打开源码初始化向导，保存配置。它不会下载、安装或启动 Host，也不会更改已安装应用的桌面启动登记信息；向导中可以选择保留已有配置。

`npm start` 会依次构建 daemon 和 Host，启动当前源码目录的 daemon，等待就绪后用本地安装的 Electron 打开源码 Host。`Ctrl+C` 会停止启动器创建的两个进程。若已有 daemon 或 Host 正在运行，请先退出，避免混用发行版和源码实例。

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
| [`src/preload/index.ts`](src/preload/index.ts)                   | 受限的渲染进程通信接口，以及音频、摄像头引擎               |
| [`src/renderer/live-view.ts`](src/renderer/live-view.ts)         | 主界面、授权页、状态条；设置与子智能体视图位于同目录       |
| [`src/native/appshot.mm`](src/native/appshot.mm)                 | 前台窗口截图、辅助功能文本与完整显示器采集                 |
| [`src/shared`](src/shared)                                       | 协议解析、IPC 类型、布局常量和主题                         |

主窗口和子智能体窗口都启用 `contextIsolation` 和渲染进程沙箱，关闭 `nodeIntegration`；默认禁止页面跳转和打开新窗口。新增能力通过明确的 preload API 和 IPC 消息接入，由主进程校验发送窗口、字段、长度和通话代次（epoch）。渲染进程（renderer）不应获得任意执行 Node.js 或访问文件系统的权限。

### 布局与交互

主窗口几何参数位于 [`overlay-geometry.ts`](src/shared/overlay-geometry.ts)，子智能体窗口参数位于 [`subagents-geometry.ts`](src/shared/subagents-geometry.ts)，原生位置约束位于 [`overlay-position.ts`](src/main/overlay-position.ts)。透明窗口画布大于实际可见内容；初始化页、主界面、预览和设置需要分别按内容及阴影范围限位。

修改布局时，检查屏幕边缘、多显示器、负坐标、缩放、显示器移除，以及设置和预览展开的情况。临时调整位置时保留用户保存的位置，并确认状态刷新或截图不会移动 UI。媒体和编辑控件应保持挂载，避免字幕更新导致焦点、预览或草稿丢失。子智能体面板由 [`subagents-windows.ts`](src/main/subagents-windows.ts) 管理，展开详情时应避开主界面和状态条。

主 UI 使用 234 × 171 px 交互卡片，包含常驻通话控件和任务摘要。拖动卡片背景、状态文字、波形或摄像头预览可移动 UI，按钮仍执行各自操作。无字幕时，预览位于卡片上方 12 px；字幕另有预留空间。设置在卡片旁展开，点击任务摘要可打开子智能体窗口。终端会话、指令投递、会话报告、搜索、视觉分析和 Monitor 各自展示状态与详情。

默认配色为 Iris（雾紫）。**设置 → 个性化 → 配色** 提供七种带名称的色样：`iris`、`clay`、`sage`、`tide`、`graphite`、`rose` 和 `berry`。选择配色后，经校验的 IPC 只修改已连接 daemon 配置文件的顶层 `themeColor`，保留其他配置。主 UI 与子智能体窗口同步更新，不重建媒体流、移动窗口或丢弃正在编辑的内容。Host 也会在连接或重连时读取此字段；未设置或取值无效时使用 Iris。浅色、深色和跟随系统的外观选项单独保存，见[配置指南](../../docs/configuration_ZH.md#主题配色)。

## 与 daemon 的边界

Host 通过回环地址上的 WebSocket 端点 `/live/host` 连接 daemon。默认发现文件为 `~/.qwen-live-harness/run/daemon.json`，权限为 `0600`，包含实例 PID、随机标识（nonce）和连接凭据，不应记录或公开分享其中的凭据。

协议当前为 **v9**，两端定义分别位于：

- Host：[`src/shared/protocol.ts`](src/shared/protocol.ts)。
- Daemon：[`src/host/types.ts`](../qwen-live-harness/src/host/types.ts) 与 [`qwen-live-harness-host-coordinator.ts`](../qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts)。

修改消息时，同时检查两端解析和能力协商，并拒绝来自已结束通话代次的媒体和会话操作。进程级控制绑定 daemon 实例 nonce，播放回执还需匹配 output ID。模型名称、API key、会话配置和工具结果都由 daemon 管理；Host 只提交设备输入并播放返回音频，不直接创建 Realtime 响应或提交模型音频缓冲区。

已安装的 Host 使用 `run/runtime.json` 中登记的 Node.js、CLI 路径和工作目录按需启动 daemon，并通过内部参数 `--daemon-only` 避免循环启动。普通断线只重连，不反复重启进程。CLI 启动的 Host 会接收对应的发现文件路径和所属实例身份，并在收到该 daemon 实例的退出通知后关闭。

`End call`（结束通话）结束交互并保留桌面界面；`Quit Qwen Live Harness`（退出 Qwen Live Harness）同时关闭 Host 和 daemon。退出未得到确认时，界面会保留错误信息和重试入口。实例身份、启动与退出逻辑见 [`daemon-bootstrap.ts`](src/main/daemon-bootstrap.ts)、[`daemon-lifecycle.ts`](src/main/daemon-lifecycle.ts)。发行版 CLI 与 Host 必须版本配套，协议号相同并不意味着不同版本兼容。

## 设备与权限

| 当前视觉模式       | 所需 macOS 权限  |
| ------------------ | ---------------- |
| Screen + On Demand | 麦克风、屏幕录制 |
| Screen + Live Feed | 麦克风、屏幕录制 |
| Camera             | 麦克风、摄像头   |

未选中来源的权限不应阻止交互。默认快捷键 `Command+E` 使用 Electron `globalShortcut`，不需要“输入监控”（Input Monitoring）权限。macOS 分别管理开发用 Electron 和发行版应用的权限，测试时应确认运行的是哪一个应用。

Appshot 是随 Host 构建的内置模块，不依赖单独的截图应用、CLI、MCP 服务或运行时下载。Screen On Demand、Live Feed 和视觉 Proactive Monitor 都采集选定显示器的完整画面，并排除 Host 自身窗口。On Demand 保存原始 PNG 资产，再按分辨率配置和传输上限编码截图；完整显示器采集不需要辅助功能权限。摄像头使用同一引擎提供预览、实时帧和单次截图，隐藏预览不会停止采集。

daemon 将 On Demand 截图交给只读视觉分析子智能体，其文字结果由隔离的纯播报连接生成语音，同时作为静默证据保留在主对话中。视觉、搜索和后台任务结果共用无工具的播报通路；Host 只播放结果音频，并回报真实的播放开始／完成状态。Host 在 Subagents 中展示进度和结果，不直接调用模型。Live Feed 和 Proactive 使用各自的输入通路。来源、模式、分辨率和使用限制见[配置指南](../../docs/configuration_ZH.md)。

Subagents 展示后台提供的命令／参数、工作目录和资源，并提供当前请求的允许／拒绝按钮。设置中的全局**后台 Harness 授权**选择 `permissionMode: "ask"`（默认）或 `"allow-all"`，后者自动处理当前等待及之后的请求；界面只采用 daemon 确认保存成功后的状态。每次批准都使用后台单次选项，不创建原生持久授权。通话中会播报重要自动操作，普通目录／状态检查只记录，没有通话就不播放音频。批准与开始执行是两种不同事实。旧逐项策略文件被忽略，不会删除；见[语音授权与持续允许](../qwen-live-harness/README_ZH.md#语音授权与持续允许)。

采集尺寸和协议上限需要分开校验：实时帧目前最多 `1920 × 1080`、每帧 `190 KiB`，截图资产上限为 `8 MiB`。即使请求了更大的采集尺寸，传输前也可能缩小。摄像头原生截图优先使用拍照接口，不可用时尝试按视频采集约束获取画面；不支持的请求应返回明确错误。修改尺寸或编码策略时，同时检查 [`camera-engine.ts`](src/preload/camera-engine.ts)、[`appshot-capture.ts`](src/main/appshot-capture.ts) 和共享协议限制。

### 音频与故障恢复

麦克风通过 AudioWorklet 转为单声道 16-bit、16 kHz PCM。daemon 请求模型输出 **24 kHz PCM**，Host 按同一采样率解码。播放 AudioContext 使用输出设备自身的采样率，不强制切换系统设备时钟。协商了结束标记的连接采用连续流式重采样，并等待对应输出真正播放完毕。修改时保持帧顺序、output ID 和播放完成回执一致。

播放使用 **10 ms 调度余量**，不改变 PCM 流的播放速度。已排队分片连续衔接，不会每片再等 10 ms；停止播放或关闭播报会立即清理待播音频。响应生成、音频转发和设备实际播放是不同阶段，通知送达需要对应的播放回执。

启用蓝牙耳机自带的麦克风时，macOS 可能切换到免提模式，这与模型输出采样率是两回事。测试时可搭配内置或 USB 麦克风与蓝牙耳机输出；强制修改采样率并不能解决系统音频路由问题。

录音启动、设备切换和音频恢复都有超时限制。主进程最多等待 10 秒，确认设备就绪并收到首个输入帧；输入静音时只需确认设备就绪。关闭 AudioContext 最多等待 1 秒。停止、静音、切换通话和退出会取消不再需要的操作；取消后才返回的媒体流和 AudioContext 也需要释放，不能将取消操作误报为就绪或新的播放故障。

音频超时会结束当前通话，但 UI、设置、拖动和退出功能仍可使用，不会立即循环重试。用户可选择输入设备，再点击开始通话或按 `Command+E` 重试。音频故障不会撤销系统授权；确实缺少权限时，界面优先显示授权提示。对应实现见 [`capture-readiness.ts`](src/main/capture-readiness.ts)、[`audio-operation.ts`](src/preload/audio-operation.ts) 和 [`audio-engine.ts`](src/preload/audio-engine.ts)。

## 日志与文案

Host 偏好设置和常规错误日志保存在 Electron `userData` 目录下，默认路径为：

```text
~/Library/Application Support/qwen-live-harness-host/
├── overlay-position.json
├── language.json
├── theme.json
└── logs/
    ├── host-errors.log
    ├── host-errors.log.1
    ├── host-window-trace.jsonl     # 仅 debug
    └── host-window-trace.jsonl.1
```

未开启 debug 时也会记录部分故障事件。这类日志只记录预先允许的错误码、阶段、epoch 等元数据，文件权限为 `0600`；达到 1 MiB 时轮转，保留当前文件和一份备份。日志写入失败不会中断音视频或退出流程，见 [`host-diagnostics.ts`](src/main/host-diagnostics.ts)。

`--live-harness-debug` 记录 Host 状态、设备和帧传输诊断。daemon 的 `--debug` 在 `<dataDir>/debug/run-*` 归档主模型、Monitor、搜索、视觉分析和通知播报五类连接，以及运行和控制事件。这些归档含有提示词、Memory 上下文、工具和媒体等私密内容；凭据脱敏不会去除音视频中的敏感信息。每个 Monitor 的媒体归档另行保存。离线检查和导出方法见[运行归档与离线检查](../qwen-live-harness/README_ZH.md#运行归档与离线检查)，不会执行记录中的任务；面向用户的诊断开关和数据路径见[配置指南](../../docs/configuration_ZH.md)。

固定展示文本统一放在 [`packages/qwen-live-harness/src/i18n/messages.ts`](../qwen-live-harness/src/i18n/messages.ts)，每个键包含 `en` 与 `zh-CN`。Host 在构建时通过别名打包共享的文案、启动和子智能体模块，不在运行时依赖已安装的 daemon npm 包。修改共享文件后，需要重新构建并验证两个包。

窗口跟踪日志（trace）记录截图 ID、原生外框与内容区域坐标、布局和尺寸变化，以及偏移的发送和应用结果。每条记录标明进程，启动记录还包含 Host 构建哈希。该日志仅在 debug 下启用，达到 4 MiB 时轮转，保留当前文件和一份备份；只记录有大小限制的几何数据和预定义状态标签，不含画面、对话、配置或凭据。排查位移时应结合内容区域坐标和 renderer 偏移：原生外框高度变化不一定意味着可见 UI 移动。

## 测试与打包

在仓库根目录运行 Host 检查：

```sh
npm --prefix packages/qwen-live-harness-host run typecheck
npm --prefix packages/qwen-live-harness-host test
npm run build:host
```

修改协议、共享文案或生命周期时，也运行 daemon 的相关测试和根目录类型检查。自动化测试覆盖协议、布局、媒体时钟、超时和退出流程；真实设备、权限弹窗、拖动和签名安装仍需在 macOS 上验证，并在 PR 中注明测试环境。

生成本地安装包，不发布到 GitHub 或 npm：

```sh
npm --prefix packages/qwen-live-harness-host run dist:mac:no-publish
```

编译产物在 `dist/`，安装包在 `release/`。打包配置见 [`electron-builder.yml`](electron-builder.yml)：App ID 为 `com.alibaba.qwen-live-harness.host`，产品名为 `Qwen Live Harness Host`，正式安装路径为 `/Applications/Qwen Live Harness Host.app`。原生模块作为独立资源随应用签名，并保留 ASAR 完整性校验和 Electron fuse 限制。构建成功后仍需验证正式签名与公证。

### 发布维护

发布入口是 [Qwen Live Harness Host Release](../../.github/workflows/qwen-live-harness-host-release.yml)。推送到 `main` 会运行 CI，相关 PR 会试运行打包流程（dry run）；正式发布需从 `main` 手动触发。发布版本必须与已提交的 daemon、Host 版本及各自锁文件一致。公开的 Release 和 npm 版本不可覆盖，`clobber` 仅用于尚未公开的草稿。

稳定版流程依次完成构建和测试、Developer ID 签名与公证、创建 GitHub Release、同步 OSS 镜像，再发布 npm 包。产物包含 arm64/x64 的 ZIP、DMG、`Qwen-Live-Harness-Host-manifest.json` 和校验文件；版本标签为 `qwen-live-harness-host-vX.Y.Z`，稳定版下载源为 `qwen-live-harness-host-latest`。草稿不发布 npm；预发布版本使用 npm `preview` 标签，不更新稳定版 Host 下载源。

正式安装器检查版本、manifest、SHA-256、bundle ID、Developer ID 团队 `NF4574S59H`、`codesign --deep --strict` 和 Gatekeeper。修改签名配置时，核对 [`build/entitlements.mac.plist`](build/entitlements.mac.plist)，并保留这些校验和对 renderer 的权限限制。

[OSS 同步工作流](../../.github/workflows/sync-qwen-live-harness-host-to-oss.yml) 使用 `ossutil` 上传按版本存放的 ZIP 和 manifest，验证公开下载成功后再更新 `latest` manifest。默认地址为 `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/qwen-live-harness-host`。安装器优先从 OSS 下载，失败后尝试本仓库的 GitHub 下载源。OSS 同步可以单独重跑；使用 GitHub 回退下载时，仓库和 Release 必须对下载者可访问。

维护者需要配置：

- Apple 签名与公证凭据：工作流支持 `APPLE_CERTIFICATE`／`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_ISSUER`／`APPLE_API_KEY`／`APPLE_API_KEY_P8` 和 `APPLE_TEAM_ID`；替代变量与编码格式以工作流为准。
- OSS 上传凭据：`ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET`，配置在 `production-release` 环境中；可选的 bucket、endpoint 和公开下载地址变量见同步工作流。
- npm [Trusted Publisher](https://docs.npmjs.com/trusted-publishers)：绑定 `QwenLM/Qwen-Live-Harness`、工作流文件 `qwen-live-harness-host-release.yml` 和 `production-release` 环境。发布任务通过 `id-token: write` 使用 OIDC，不读取 `NPM_TOKEN`；公开仓库发布附带来源证明（provenance）。工作流固定使用支持 Trusted Publishing 的 Node.js/npm 版本。

## 许可证

[Apache License 2.0](../../LICENSE)。
