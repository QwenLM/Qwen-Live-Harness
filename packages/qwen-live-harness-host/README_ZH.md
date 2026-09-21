# Qwen Live Harness Host 开发指南

简体中文 | [English](README.md)

[项目首页](../../README_ZH.md) · [配置与功能指南](../../docs/configuration_ZH.md) · [Daemon 开发指南](../qwen-live-harness/README_ZH.md)

Host 是 macOS 桌面端，负责 UI、权限、音频采集与播放、摄像头和屏幕采集，以及全局快捷键。模型连接、工具、后台任务、Memory 和 Proactive 由 daemon 管理。Host 不直接调用模型 API，也不附带 Node.js 或 daemon 安装包。

本文面向桌面端开发者，安装与日常设置见[配置与功能指南](../../docs/configuration_ZH.md)。

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

`npm run init` 构建 daemon 并保存配置，也可选择保留已有配置。它不安装或启动 Host，不更改已安装应用的桌面启动登记信息。

`npm start` 构建两个包，启动当前源码的 daemon，就绪后用本地 Electron 打开源码 Host。`Ctrl+C` 停止启动器创建的两个进程。请先退出已有实例，避免混用源码与发行版。

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

窗口启用 `contextIsolation` 和渲染进程沙箱，默认禁用 `nodeIntegration`、页面跳转和新窗口。通过明确的 preload API 与 IPC 消息扩展能力，由主进程校验发送方、字段、长度和通话代次（epoch），不要向 renderer 暴露任意 Node.js 执行或文件系统访问能力。

### 布局与交互

几何参数位于 [`overlay-geometry.ts`](src/shared/overlay-geometry.ts)、[`subagents-geometry.ts`](src/shared/subagents-geometry.ts) 和 [`overlay-position.ts`](src/main/overlay-position.ts)。按实际可见内容限位，不要按更大的透明画布限位。[`subagents-windows.ts`](src/main/subagents-windows.ts) 负责让详情面板避开主 UI 和状态条。

测试拖动、屏幕边缘、多显示器、负坐标、缩放、显示器移除，以及设置／预览展开。临时布局调整须保留已保存的位置；截图和状态刷新不能移动 UI。媒体与编辑控件保持挂载，保留焦点、预览和草稿。主题通过经校验的 IPC 更新，不重建媒体流或丢弃编辑内容；使用选项见[配置指南](../../docs/configuration_ZH.md#主题配色)。

## 与 daemon 的边界

Host 通过回环地址 WebSocket 端点 `/live/host` 连接 daemon。发现文件为 `~/.qwen-live-harness/run/daemon.json`（权限 `0600`），包含实例 PID、nonce 和连接凭据，不应记录或分享其内容。

协议当前为 **v9**，两端定义分别位于：

- Host：[`src/shared/protocol.ts`](src/shared/protocol.ts)。
- Daemon：[`src/host/types.ts`](../qwen-live-harness/src/host/types.ts) 与 [`qwen-live-harness-host-coordinator.ts`](../qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts)。

同时校验两端消息解析与能力协商。拒绝已结束通话代次的操作，进程控制绑定 daemon nonce，播放回执匹配 output ID。Host 只提交设备输入、播放输出；API key、模型会话、Realtime 响应、音频 commit 和工具结果均由 daemon 管理。

已安装的 Host 从 `run/runtime.json` 登记的路径启动 daemon，以内部参数 `--daemon-only` 避免循环启动。普通断线只重连，不重启进程。CLI 启动的 Host 归属于对应 daemon 实例，并在其退出通知后关闭，见 [`daemon-bootstrap.ts`](src/main/daemon-bootstrap.ts) 和 [`daemon-lifecycle.ts`](src/main/daemon-lifecycle.ts)。

`End call`（结束通话）保留 UI；`Quit Qwen Live Harness`（退出）同时停止 Host 和 daemon。退出未确认时保留错误提示和重试入口。发行版 CLI 与 Host 的版本必须一致，不能只看协议号。

## 设备与权限

| 当前视觉模式 | 所需 macOS 权限  |
| ------------ | ---------------- |
| Screen       | 麦克风、屏幕录制 |
| Camera       | 麦克风、摄像头   |

未选中来源的权限不能阻止交互。`Command+E` 使用 Electron `globalShortcut`，无需输入监控权限。开发 Electron 与发行版应用在 macOS 中是不同的权限身份。

内置 Appshot 无需单独的截图应用、CLI、MCP 服务或运行时下载。Screen On Demand、Live Feed 和视觉 Monitor 采集选定显示器完整画面并排除 Host 窗口，不需要辅助功能权限。On Demand 保留原始 PNG，再编码为满足传输限制的截图。摄像头预览、实时帧和截图共用引擎；隐藏预览不会停止采集。

Host 展示子智能体进度／结果，播放 daemon 生成的音频并回报真实播放开始／完成状态。截图分析、Live Feed、Proactive 和结果调度属于 daemon，见[语音与视觉](../qwen-live-harness/README_ZH.md#语音与视觉)。

Subagents 展示后台命令、参数、工作目录和资源，提供允许／拒绝操作。设置可选择 `permissionMode: "ask"` 或 `"allow-all"`，只应用 daemon 确认的更改。后台批准与开始执行是不同状态，批准不会创建原生持久授权。策略和通知行为见[语音授权与全局授权模式](../qwen-live-harness/README_ZH.md#语音授权与全局授权模式)。

分别校验采集尺寸与传输上限：实时帧最多 `1920 × 1080`、`190 KiB`；截图资产最多 `8 MiB`。摄像头截图优先拍照接口，再回退视频采集约束；不支持的请求须明确报错。调整编码或尺寸时，同时检查 [`camera-engine.ts`](src/preload/camera-engine.ts)、[`appshot-capture.ts`](src/main/appshot-capture.ts) 与共享协议限制。

### 音频与故障恢复

麦克风通过 AudioWorklet 转为单声道 16-bit、**16 kHz PCM**。模型输出 **24 kHz PCM**，播放使用输出设备的 AudioContext 采样率，不强制修改系统采样率。协商了结束标记的连接采用连续流式重采样。保持帧顺序、output ID 和播放开始／完成回执一致：已生成、已转发不等于已播放。

播放保留 **10 ms 调度余量**，分片连续衔接，不逐片增加延迟。停止和关闭播报立即清理待播音频。蓝牙麦克风可能触发 macOS 免提模式，与模型采样率无关；设备测试应包含内置／USB 输入搭配蓝牙输出。

采集就绪最多等待 10 秒确认设备和首帧（静音时只检查就绪），AudioContext 关闭最多等待 1 秒。停止、静音、通话切换和退出取消待完成操作，并释放迟到的资源。超时结束通话但不循环重试，设置、拖动、退出和手动重试须保持可用；不要将音频故障当作权限撤销。见 [`capture-readiness.ts`](src/main/capture-readiness.ts)、[`audio-operation.ts`](src/preload/audio-operation.ts) 和 [`audio-engine.ts`](src/preload/audio-engine.ts)。

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

`host-errors.log` 未开启 debug 也记录预先允许的故障元数据，权限为 `0600`，达到 1 MiB 轮转并保留一份备份。日志故障不能中断媒体或退出，见 [`host-diagnostics.ts`](src/main/host-diagnostics.ts)。

`--live-harness-debug` 开启状态／设备／传输诊断和窗口 trace。trace 只含有大小限制的几何数据与预定义标签，不含画面、对话或凭据；达到 4 MiB 轮转并保留一份备份。排查位移时比较内容区域坐标和 renderer 偏移，不要只看原生外框尺寸。

daemon 模型／媒体归档单独保存，凭据脱敏后仍可能包含敏感提示词、Memory、工具数据、音频和图片。位置、检查及导出方法见[运行归档与离线检查](../qwen-live-harness/README_ZH.md#运行归档与离线检查)。

固定展示文本集中在 [`messages.ts`](../qwen-live-harness/src/i18n/messages.ts)，使用成对的 `en`／`zh-CN` 条目。构建别名打包共享文案、启动和子智能体模块；Host 不在运行时依赖已安装的 daemon 包。共享内容修改后重新构建并测试两个包。

## 测试与打包

在仓库根目录运行 Host 检查：

```sh
npm run lint:host
npm run typecheck:host
npm run test:host
npm run build:host
```

根目录 `npm test` **不包含** Host 测试。`npm run lint:all` 检查两个包；修改共享内容、协议或生命周期时，还须运行根目录类型检查和 daemon 相关测试。自动化检查不能替代 macOS 真实设备、授权、拖动和签名安装验证，请在 PR 中注明测试环境。

生成本地安装包，不发布到 GitHub 或 npm：

```sh
npm --prefix packages/qwen-live-harness-host run dist:mac:no-publish
```

编译产物在 `dist/`，安装包在 `release/`。[`electron-builder.yml`](electron-builder.yml) 定义 App ID `com.alibaba.qwen-live-harness.host` 和安装路径 `/Applications/Qwen Live Harness Host.app`。原生模块作为独立资源签名；保留 ASAR 完整性校验与 Electron fuse 限制，构建成功不能替代正式签名和公证验证。

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
