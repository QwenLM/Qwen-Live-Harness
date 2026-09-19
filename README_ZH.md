# Qwen-Live-Harness

<p align="center">
  <b>中文</b> ｜ <a href="README.md">English</a>
  <br>
  <a href="#news">News</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#使用与配置">使用与配置</a> ·
  <a href="#开发上手">开发上手</a> ·
  <a href="#架构设计">架构设计</a> ·
  <a href="https://help.aliyun.com/zh/model-studio/user-guide/qwen-omni">API 文档</a>
</p>

<p align="center">
  <img src="https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3.8-Omni-Flash/fig3.png" alt="Qwen-Live-Harness：实时多模态交互、复杂任务委托、主动交互与长期记忆" width="100%">
</p>

**Qwen-Live-Harness** 是围绕 **Qwen Omni Realtime API** 构建的开源 Harness，使用一行命令安装，即可接入各种主流 Harness 智能体，把实时音视频交互、负责任务后台委托、主动交互和长期记忆带到桌面端，所有源码均开源，欢迎社区开发者共同扩展后端、交互方式和应用场景。

## News

- **2026-09-19**：🎉 我们正式发布了 **Qwen3.8 Omni Flash Realtime** 和配套的 [**Qwen-Live-Harness**](https://github.com/QwenLM/Qwen-Live-Harness)！

## Qwen Live Harness 可以做什么

- **实时交流**：结合屏幕或摄像头以音视频的方式进行交互，支持切换输入设备、视觉来源和采集模式，并可视化管理子智能体。
- **委托任务**：把工作交给 Qwen Code、Qoder CLI、Codex、Claude Code、Gemini CLI 等后台 Harness，并进行查看进度、处理授权、接收结果，也可按需接入已运行的 Qwen Code 终端，在授权后发送文字指令、接收主动报告。
- **主动交互 · Proactive**：设置音频、画面或时间条件，在事件发生时主动提醒，可完成音视频条件监视，实时解说等功能。
- **长期记忆 · Memory**：跨对话保留偏好和上下文，支持多个记忆库，以及对其进行创建、切换和重命名功能。

## 快速开始

完整桌面体验目前支持 **macOS 12+**，兼容 Apple Silicon 和 Intel Mac，需要联网调用阿里云百炼 DashScope API，无需下载模型权重或准备本地 GPU，对 Windows 和 Linux 等其他平台的支持也正在进行中。

### 1. 安装 Node.js 和 npm

打开 [Node.js 官方下载页](https://nodejs.org/en/download)，选择 **macOS**，下载安装 **22.13 或更新版本**的 LTS 安装包（`.pkg`），按安装向导完成安装，或者直接使用命令行在终端安装:

```sh
# Download and install nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
# in lieu of restarting the shell
\. "$HOME/.nvm/nvm.sh"
# Download and install Node.js:
nvm install 24
```

**npm 会随 Node.js 一起安装，不需要单独下载。** 安装后重新打开“终端”，检查：

```sh
node --version
npm --version
```

第一行应显示 `v22.13.0` 或更高版本，第二行应显示 npm 版本号。

### 2. 获取 DashScope API key

1. 登录 [阿里云百炼控制台的 API key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)，按控制台提示开通模型服务。
2. 选择要使用的服务地域，创建 API key，并确认它有权调用所需的 Qwen Omni Realtime 模型与 Qwen 文本模型。
3. 复制 API key，在下一步初始化时填入。具体操作见 [获取与配置 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)；国际站入口见 [各地域接入信息](https://help.aliyun.com/zh/model-studio/regions)。

初始化支持 **北京（国内站）** 和 **新加坡（国际站）**。北京和新加坡地域的 API key 不能混用，请确认使用的是在所选地域创建的 API key。模型可用范围和调用费用以对应地域的控制台为准。

### 3. 安装、初始化、启动

```sh
npm install -g qwen-live-harness
qwen-live-harness init
qwen-live-harness
```

初始化向导会依次配置语言、后台任务委托Harness、DashScope API key、Realtime 模型、API key 服务地域和 Memory，语言、地域和是／否选项支持左右方向键切换，回车确认。

启动后，按界面提示授予麦克风和所选视觉来源需要的权限，连接、权限和设备就绪后，即可开始交互，此后运行 `qwen-live-harness`即可启动，也可从应用程序或启动器打开 **Qwen Live Harness Host**。

需要调整模型相关的高级设置时，请参阅 [配置指南](docs/configuration_ZH.md)。

## 使用与配置

可视化 UI 支持打开关闭麦克风和扬声器、开始／结束通话、设置和退出功能，按 **Command + E** 也可以开始或结束通话。

可以试着说：

> “帮我把屏幕上的 Git Project 拉取到本地”
>
> “对当前画面进行一个详细的解说”
>
> “监测当前屏幕，出现代码运行报错时提醒我”
>
> “最近有什么好玩的新闻，给我讲一讲”
>
> “调研一下目前国际上 AI 的发展情况，总结一个文档到下载目录下”

在设置的 **Sound / 声音** 中选择麦克风，在 **Visual / 视觉** 中选择 **Video Source / 视频来源** 和 **Capture Mode / 采集模式**。**On Demand / 按需截图** 会把选定显示器或摄像头的截图交给独立视觉子智能体分析，无需后台 Harness 也能回答画面问题；需要让主模型持续看到画面时，选择 **Live Feed / 实时画面**，默认实时采集为 **1 FPS、720p**。

可以在 UI 中打开 **Subagents / 子智能体**，查看画面分析、联网搜索、后台任务和主动交互 Monitor 的运行情况，并处理权限请求或停止任务。Monitor 固定按 **1 FPS、每轮 2 秒**观察，通知等待当前对话和播放结束后依次播报。采样和模型推理存在延迟，也可能误判，不应作为安全关键场景的报警系统。

配置文件默认位于 `~/.qwen-live-harness/config.json`，可通过设置页面的 **打开配置文件** 用本地编辑器打开，手动修改后重启应用即可生效。

完整参数、示例、记忆管理和排障方法见 [配置指南](docs/configuration_ZH.md)。

### 支持的后台 Harness

先安装并登录希望使用的 Harness，再在 `qwen-live-harness init` 中选择，Live 会自动建立对应的后台连接。

| Harness     | 协议                             | 接入方式                                                                                           |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| Qwen Code   | Qwen Serve（REST/SSE）或原生 ACP | 默认由 Live 托管本机 Serve，也可连接已有 Serve 或使用 `qwen --acp`。                               |
| Qoder CLI   | 原生 ACP                         | `qodercli --acp`                                                                                   |
| Codex       | ACP 适配器                       | [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)               |
| Claude Code | ACP 适配器                       | [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) |
| Gemini CLI  | 原生 ACP                         | `gemini --experimental-acp`                                                                        |

[ACP（Agent Client Protocol）](https://agentclientprotocol.com/get-started/introduction) 通过本机标准输入／输出传输 JSON-RPC 消息。Codex 和 Claude Code 的适配器由 `npx` 启动，首次使用可能需要下载依赖。可用工具、图片支持和授权行为取决于后台 Harness 及其版本。

后台 Harness 并非必需，初始化时可以选择不接入，仍可使用实时音视频交流、联网搜索、Proactive 主动交互和 Memory。

## 开发上手

项目内部由两个本机进程协作，对用户提供统一的启动入口：

- **daemon** 是 Node.js 服务，负责连接模型、管理对话、调用工具，以及调度后台 Harness、Proactive 和 Memory。
- **Host** 是 Electron 桌面端，负责 UI 界面、系统权限、音视频采集与播放，以及展示任务状态。

两者通过本机 WebSocket 通信：Host 将用户输入交给 daemon，daemon 处理模型与后台任务，再把语音和状态返回 Host，两端使用配套版本，可以分别开发和调试，也可以通过下方的源码入口一起启动。

需要 macOS、Node.js 22.13+ 和 Xcode 命令行工具（可运行 `xcode-select --install` 安装）。Host 构建还需要可用的 Node.js headers。

```sh
git clone https://github.com/QwenLM/Qwen-Live-Harness.git
cd Qwen-Live-Harness
npm ci
npm ci --prefix packages/qwen-live-harness-host
npm run init
npm start
```

其中 `npm run init` 命令只完成配置，不下载安装 Host，而 `npm start` 会构建并同时启动源码 daemon 和 Host，不依赖全局 CLI 或已安装的 Host。开始调试前先退出已有实例。需要日志时使用 `npm start -- --debug`，退出时按 `Ctrl+C`。

| 开发指南                                                   | 内容                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| [daemon 开发指南](packages/qwen-live-harness/README_ZH.md)    | 模型连接、工具与后端适配、Proactive、Memory、协议和测试。   |
| [Host 开发指南](packages/qwen-live-harness-host/README_ZH.md) | Electron UI 界面、系统权限、音视频、原生截图、窗口布局与打包。 |

接入已有 Qwen Code 终端需要使用独立的 **Qwen peer 协议**，支持发现终端、经授权发送文字指令，以及按需接收报告，不会接管任意终端，详见 [Qwen 终端接入](packages/qwen-live-harness/README_ZH.md#qwen-终端接入)。

## 架构设计

可以把整个系统理解成三部分：**Host 负责采集和呈现，daemon 负责调度，模型与后台 Harness 负责理解和执行。**

```mermaid
flowchart LR
  host["<b>Host · 桌面 UI</b><br/>音视频采集与播放"]
  daemon["<b>daemon · 调度中心</b><br/>对话 · 工具 · 权限"]
  omni["<b>Qwen Omni Realtime</b><br/>云端理解与语音回答"]
  host <-->|本机 WebSocket| daemon
  daemon <--> omni
  harness["<b>任务委托</b><br/>可选后台 Harness<br/>ACP · Qwen Serve"]
  search["<b>联网搜索</b><br/>Omni Realtime<br/>原生搜索"]
  visual["<b>按需视觉</b><br/>Omni Realtime<br/>截图分析"]
  monitor["<b>Proactive</b><br/>Omni Realtime<br/>音频／画面监视"]
  memory[("<b>Memory</b><br/>本地记忆库<br/>云端整理与向量化")]

  daemon <--> harness
  daemon <--> search
  daemon <--> visual
  daemon <--> monitor
  daemon <--> memory

  classDef local fill:#eef4ff,stroke:#a5bde8,color:#193457,stroke-width:1px
  classDef model fill:#f0ecff,stroke:#b7a5e8,color:#382965,stroke-width:1px
  classDef optional fill:#edf7f2,stroke:#9acbb2,color:#234d3d,stroke-width:1px
  classDef storage fill:#fff6e6,stroke:#dfc086,color:#664b22,stroke-width:1px
  class host,daemon local
  class omni,search,visual,monitor model
  class harness optional
  class memory storage
```

用户可以对着 Qwen Live Harness 提出需求，驱动它的 Qwen Omni 理解后直接回答，或调用工具将复杂的生产任务交给后台 Harness，前台仍可异步进行对话和交互，后台的任务的触发结果后会排队交回主会话播报，此外还有 Memory 为后续对话提供相关上下文。

了解下面几条，就能更好地选择使用方式：

- **后台 Harness 的能力边界：** 音视频交互、Proactive 和 Memory 可以独立使用，文件修改、命令执行等任务需要已安装并登录的后台 Harness，能力和权限取决于该后端。应用不会自动接管任意终端中的既有任务。
- **“看画面”有不同路径：** On Demand 截取选定显示器的完整画面或摄像头画面，将视觉子智能体的分析交回主对话；Live Feed 持续将图片交给主模型。Proactive Monitor 独立观察所选来源，不会代替用户打开网页或操作应用。
- **记忆存储在本地，推理仍在云端：** 个性化信息和跨 Session 的记忆保存在可管理的本地记忆库中。记忆整理、可选视觉观察和向量化会把相关内容发送到配置的模型 API，本地存储不等于离线推理。

## 社区共建

欢迎通过 [Issues](https://github.com/QwenLM/Qwen-Live-Harness/issues) 分享问题、场景和建议，或提交 [Pull Request](https://github.com/QwenLM/Qwen-Live-Harness/pulls) 参与开发。

报告问题时，请提供版本、系统环境、后端类型、复现步骤及脱敏日志，注意避免提交 API key、私人对话或未脱敏的屏幕画面，在 Debug 模式下保存的日志可能保存敏感的音视频信息，请务必检查后再提交。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
