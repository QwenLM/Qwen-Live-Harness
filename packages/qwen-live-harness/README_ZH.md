# Qwen Live Harness · Daemon 开发指南

简体中文 | [English](README.md)

本目录包含 `qwen-live-harness` npm 包。后台服务（daemon）负责模型连接、对话调度、任务委托、Proactive 和 Memory；独立的 macOS Host 负责桌面界面、系统权限和设备采集。

[项目介绍与安装](../../README_ZH.md) · [配置与功能指南](../../docs/configuration_ZH.md) · [Host 开发指南](../qwen-live-harness-host/README_ZH.md)

[源码运行](#从源码运行) · [代码入口](#先看哪些代码) · [后端适配](#接入新的后台-harness) · [Qwen 终端](#qwen-终端接入) · [协议](#协议与能力边界) · [高级配置](#高级配置参考)

## 从源码运行

需要 Node.js **22.13+**；完整桌面交互目前需要 macOS。以下命令均在**仓库根目录**执行：

```bash
npm ci
npm ci --prefix packages/qwen-live-harness-host
npm run init
npm start
```

`npm run init` 构建 daemon、打开源码初始化向导并保存配置，不会下载或安装 Host，也不会更改已安装桌面应用的运行时登记。可以选择后台编程助手，也可以暂不接入后台 Harness。

选择 Qwen Code 时，默认使用由 Live 管理的本地 Qwen Serve，也可连接已有本地服务或选择 ACP。初始化只保存设置，由 Live 管理的服务会在 daemon 启动时运行。发现终端和获得操作权限是两回事，详见 [Qwen 终端接入](#qwen-终端接入)。

`npm start` 构建两端，并启动当前源码目录的 daemon 和 Electron Host，不使用全局 CLI 或 `/Applications` 中的 Host。请先退出正在运行的 Qwen Live Harness；源码启动器不会接管已有实例。`Ctrl+C` 会停止本次启动的进程。

需要诊断日志时运行：

```bash
npm start -- --debug
```

源码入口由 [`scripts/start-dev.mjs`](../../scripts/start-dev.mjs) 管理。已安装 npm 包的用户启动流程不同，见[项目首页](../../README_ZH.md#快速开始)。

## 先看哪些代码

| 位置                                                                                           | 职责                                           |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [`src/index.ts`](src/index.ts)、[`src/cli-startup.ts`](src/cli-startup.ts)                     | CLI 入口、实例复用、启动和退出                 |
| [`src/config.ts`](src/config.ts)、[`src/init.ts`](src/init.ts)                                 | 配置校验、环境变量优先级、交互初始化           |
| [`src/peer-setup.ts`](src/peer-setup.ts)、[`src/peer-diagnostics.ts`](src/peer-diagnostics.ts) | Qwen 终端增量设置和只读诊断                    |
| [`src/daemon.ts`](src/daemon.ts)                                                               | 组装服务、Host HTTP/WebSocket 入口、资源清理   |
| [`src/host/`](src/host/)                                                                       | Host 协议、发现文件、通话状态和安装器          |
| [`src/orchestrator/`](src/orchestrator/)                                                       | 对话生命周期、工具分发、后台事件与播报队列     |
| [`src/realtime/`](src/realtime/)                                                               | 主 Realtime 协议、系统提示词、独立文本搜索连接 |
| [`src/adaptor/`](src/adaptor/)                                                                 | 后端适配器、能力声明和事件格式统一             |
| [`src/tools/`](src/tools/)                                                                     | 模型工具定义、回执、session/job/asset 句柄     |
| [`src/permissions/`](src/permissions/)                                                         | 后台真实授权请求的转发与答复                   |
| [`src/proactive/`](src/proactive/)                                                             | 监控、计时、事件触发与 FIFO 播报               |
| [`src/memory/`](src/memory/)                                                                   | 本地记忆库、检索、整理和可选视觉观察           |
| [`src/subagents/`](src/subagents/)                                                             | 子智能体状态、详情和手动停止接口               |
| [`src/log/`](src/log/)、[`src/logger.ts`](src/logger.ts)                                       | 会话记录与运行诊断                             |
| [`src/i18n/messages.ts`](src/i18n/messages.ts)                                                 | CLI 与 Host 共用的中英文固定展示文案           |

一次通话的主要调用链是 `LiveDaemon → LiveHostCoordinator → LiveSession → Realtime / BackendAdaptor`。Qwen Serve 是 REST/SSE 后端，可由 Live 启动，也可连接已有服务；ACP 和无后台模式都不需要它。

## 构建与测试

```bash
npm run build
npm run typecheck
npm run test:daemon
npm run test:scripts
npm run test:integration
```

只跑一个 daemon 测试文件：

```bash
npm test --workspace qwen-live-harness -- src/orchestrator/live-session.test.ts
```

仓库还提供 `npm run lint`、`npm run format:check`、`npm run check:boundaries` 和 `npm run check:package`。最后一项会检查实际 npm tarball、安装后的命令和包边界。Host 的构建、类型检查与测试见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md)。

默认的单元测试和协议测试使用测试替身及本地服务，不依赖真实模型账号。需要真实账号的测试单独运行，须明确启用；默认测试中不应包含付费 API 调用、设备授权弹窗或个人凭据。

## 隔离配置与单独调试 daemon

配置默认位于 `~/.qwen-live-harness/config.json`，其所在数据目录也保存 Memory 和会话数据。

开发时可以为配置、Memory、会话日志和发现文件使用独立目录。在运行初始化及启动命令的终端中设置：

```bash
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-dev"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
npm run init
npm start -- --debug
```

这两个变量分别控制数据目录和发现文件的**基础目录**。只修改 `DATA_DIR` 不会改变发现文件的位置；使用独立开发配置时，需要同时隔离两者。完整优先级规则见[环境变量参考](#环境变量参考)。

需要独立运行 daemon 时，先构建，再直接调用产物：

```bash
npm run build
node packages/qwen-live-harness/dist/index.js --daemon-only --debug
```

`npm start` 是两进程开发启动器，不接受 `--daemon-only`。单独启动 Host 时，使用本仓库 Host 的开发入口，并将 `QWEN_LIVE_HARNESS_DISCOVERY_FILE` 设置为对应目录下的完整 `run/daemon.json` 路径；不要把基础目录直接传给它。

进程协作约定：

- `run/daemon.json` 记录回环地址、协议版本、PID 和实例随机标识（nonce）；连接使用 Bearer token 和 nonce 校验。发现文件属于私有运行状态，不应打印或分享其中的凭据。
- `run/runtime.json` 用于**已安装版本**的桌面启动，保存 Node.js/CLI 的绝对路径、版本和必要启动信息，不保存 API key。源码 `npm start/init` 不创建或更新这项登记。
- 正常退出会写入实例专属的停止标记（stop marker），让尚在握手或重连的 Host 也能退出。标记需要匹配所属实例，旧标记不能关闭新实例；普通断线不等于退出请求。
- End call 结束当前交互和 Proactive 采样，已委托的后台任务可以继续。退出整个应用会清理 daemon 管理的资源、ACP 子进程和自动启动的 Qwen Serve，不会终止用户独立运行的服务或终端。退出失败后重试时，仍需匹配原来的认证实例。

相关实现位于 [`startup.ts`](src/startup.ts)、[`startup-lock.ts`](src/startup-lock.ts)、[`host/discovery.ts`](src/host/discovery.ts) 和 [`lifecycle.ts`](src/lifecycle.ts)。

## 接入新的后台 Harness

如果编程助手已支持 ACP，通常只需配置 `kind: "acp"`、`command`、`args` 和必要的 `env`。若希望初始化向导自动发现它，再扩展 [`agent-detector.ts`](src/agent-detector.ts) 及对应测试。

新协议的接入点是 [`BackendAdaptor`](src/adaptor/types.ts)：

1. 在 `src/adaptor/` 实现适配器，提供 `preflight`、会话管理、`prompt`、事件流、取消、授权答复和 `close`。
2. 如需新的配置类型，更新 `BackendConfig`、配置校验，以及 [`daemon.ts`](src/daemon.ts) 的 `buildAdaptor`。后端专用逻辑应留在适配层，避免分散到通话调度器中。
3. 在 `capabilities()` 中声明实际支持的能力，补充协议测试，再验证任务委托、事件关联、权限和资源清理。

可参考现有的 [`AcpAdaptor`](src/adaptor/acp-adaptor.ts) 和 [`QwenCodeAdaptor`](src/adaptor/qwen-code-adaptor.ts)。后者通过 REST/SSE 连接 Qwen Serve，由 [`ManagedQwenServe`](src/adaptor/managed-qwen-serve.ts) 负责自动启动；连接已有服务时，不管理该外部进程的生命周期。

适配时需要保持的约定：

- `prompt()` 返回受理或排队回执，不是最终结果。完成状态由 `turn_complete` 等事件确认，使用稳定的 `jobRef` 或明确的 joined-turn 标识关联。
- `steering`、`imageInput`、`permissionForwarding` 等字段应反映实际支持的能力。后端不支持图片输入时，应明确报告，而不是声称截图已送达。持续接收后台状态目前要求 `eventDelivery: "stream"`；其他投递方式还需要对应的消费端实现。
- 只转发后台实际提出的授权请求。普通文件写入失败不是授权请求，不应因此生成授权弹窗或自动同意。取消未知任务时，不能停止同一会话中的其他工作。
- `close()` 清理本适配器拥有的进程、订阅和请求。用户已有的独立服务不属于它。

`backends: []` 明确选择无后台模式，不创建占位编程助手。语音、视觉、Proactive 和 Memory 仍可使用，后台工具返回 `no_backend`。如果已配置的默认后台不可用，启动会失败，不会自动改用无后台模式。

## Qwen 终端接入

这项集成通过 Qwen 的公开 peer 协议连接已运行的 **Qwen Code 交互式终端会话**，不读取任意终端的 stdout，也不接管外部终端进程。终端发现、文本发送和报告接收分别配置。

### Qwen Code 的三种连接方式

主初始化向导为 Qwen Code 提供：

| 方式                                | 配置与生命周期                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 自动启动本地 Qwen Serve（默认选项） | `kind: "qwen-code"` 与 `managedServe.command`；在回环地址启动已安装的 Qwen，使用系统分配的端口和新 token，退出时清理该服务 |
| 连接已有本地 Qwen Serve             | `kind: "qwen-code"` 与 `baseUrl` / 可选 `token`；不启动或停止该外部服务                                                    |
| ACP                                 | `kind: "acp"`，以 `qwen --acp` 启动；不启用 peer 终端发现                                                                  |

自动启动的配置条目示例：

```json
{
  "name": "qwen",
  "kind": "qwen-code",
  "default": true,
  "managedServe": { "command": "/absolute/path/to/qwen" }
}
```

将此条目加入 `backends`，把 `command` 换成实际可执行文件路径。`managedServe` 不能与 `baseUrl`、`serveUrl` 或 `token` 同时配置，工作目录使用 `defaultCwd`。Qwen 继续使用自己的模型认证和设置；Live 不会修改这些设置，也不会代为授予终端消息权限。

选择任一 Serve 方式时，向导还会保存当前 `QWEN_HOME`（默认为 `~/.qwen`）对应的只读 `peerDiscovery`。这不会授予发送文本的权限，也不会开启报告接收。即使手动配置了远程 Serve，本地 peer 目录仍只用于发现本地终端。

<a id="terminal-setup-and-diagnostics-m3-stage-4"></a>

### 增量设置与只读诊断

已有 Live 配置后，从仓库根目录执行：

```bash
npm run build
node packages/qwen-live-harness/dist/index.js init --peers
node packages/qwen-live-harness/dist/index.js doctor --peers
```

已安装 CLI 的对应命令是 `qwen-live-harness init --peers` 和 `qwen-live-harness doctor --peers`。源码启动脚本当前不转发 `--peers`，因此使用上面的构建产物入口。

`init --peers` 只修改选定 `qwen-code` 后端的 `peerDiscovery`。可以选择已有后端，也可以添加连接已有 Serve 的条目，但不会将 ACP 转换成 Serve。其他设置和默认后端保持不变，取消操作不会写文件。运行前需要已有 `config.json`；如果后台环境变量会覆盖本次修改，命令会拒绝编辑。保存时使用锁和原子替换，请避免同时在其他编辑器中修改该文件。完成后重启 Live。

`doctor --peers` 检查配置、终端目录、连接能力和授权设置，不启动通话、发送指令或创建授权。尚未启动的 `managedServe` 会显示为未验证，诊断不会将它启动或假定其动态端口。controller 已配置，也可能对应一份已失效的授权。

### 发现现有终端

要发现终端，需在 `kind: "qwen-code"` 后端配置 `peerDiscovery.qwenHome`，指向目标终端使用的本地 Qwen home 目录。Qwen 侧需要开启 `agents.crossSessionMessaging: true`，修改后重启目标终端。省略 `peerDiscovery` 会关闭发现；ACP 条目不支持该设置。

开始通话后，`session_list` 会同时列出托管会话和可连接的 `tui` 终端。Host 的 Subagents 面板通过 **Terminal sessions** 展示终端，可点击 Refresh 更新列表。外部终端的执行状态为 `unknown`，没有 controller 授权时标为只读；它们不计入普通任务的 Running / Completed 数量。

目录和 socket 名称只用于展示。发送时使用绑定 Qwen home、会话 ID、PID 和启动时间的句柄，不会仅凭同名就选中一个终端。发现失败也不能说明终端中的任务是否完成。

### 向终端发送文本

使用支持 `sessions controllers` 的 Qwen CLI，在**同一个 Qwen home** 下手动创建控制器授权（controller grant）：

```bash
QWEN_HOME="$HOME/.qwen" qwen sessions controllers add --label "Qwen Live Harness" --json
```

通过增量设置向导保存返回的 token，或将 `peerDiscovery.controllerTokenEnv` 设为存放该 token 的环境变量名。`controllerToken` 与 `controllerTokenEnv` 只能二选一。它是独立于 Serve REST token 的凭据，不应通过语音传递。使用环境变量时，需要确保启动 Live 的进程能读取它；双击 Host 不会自动继承终端里的变量。

开始通话并列出会话后，可以要求 Live 向选定终端发送具体指令。`handoff` 发送文本后返回独立的 `delivery_N` 回执，跟踪的是投递，不是后台任务；它不确认指令是否执行、是否已用于调整当前任务，也不表示任务完成。此通道不支持截图附件、停止终端任务或答复其工具授权请求。

目标终端的 `agents.crossSessionInbound` 策略仍然有效：`hold` 要求在终端审阅，`refuse` 拒收。Host 的 **Instruction deliveries** 展示投递状态，`session_monitor` 可用 `delivery` 参数查询：

- `pending`：尝试写入，尚无回执；`held`：等待终端审阅。
- `delivered`：进入终端收件箱，不代表任务完成；之后仍可能变为 `expired` 或 `misaddressed`。
- `denied` / `refused` / `dropped` 等按实际回执展示；`unknown` 只表示结果不确定，不能自动重发。

默认等待 30 秒仍未收到回执时，投递状态变为未知。每个 controller 最多保留 100 条记录，满额时先移除已结束跟踪的条目；如果全部仍在跟踪，则拒绝新的发送请求。End call 会停止跟踪，但不能撤回已写入的指令。授权管理、撤销和终端审阅仍由 Qwen 负责。

发送前，Live 会复核注册记录，并为本次投递固定目标 socket 和完整 sessionId。协议不提供原子的 PID／启动时间校验，因此不能依靠本地目录元数据，对同一用户下运行的其他程序进行强身份认证。

### 接收报告并播报

`peerDiscovery.reports: true` 单独开启报告接收，默认关闭。接收报告不需要 controller grant，也不会赋予终端控制权限。每次通话会发布一个临时 Live peer 地址；handoff 在适用时附上该地址和报告示例。

目标会话需要提供公开的 `send_message` 工具、使用同一个 Qwen home，并获准调用该工具；Live 不会代为授权。托管会话也可以使用此工具。适配器没有自己的报告端点时，只有在恰好存在一个可用报告提供方的情况下，才会收到报告发送指引。

报告类型包括 `progress`、`blocked`、`result` 和 `info`，普通文字按 `info` 接收。Host 的 **Session reports** 展示来源、正文以及排队／已提交／播报状态，也可通过 `session_monitor` 的 `reports: true` 查询。来源无法唯一匹配时标为未确认；匹配结果用于标明来源，不提供对同一用户下任意程序的强身份认证。

报告播报会等待用户讲话、前台回复和设备播放结束，再通过无工具权限的独立响应转述。报告不是新的用户指令、授权答复或经过验证的任务完成事件。关联的托管任务仍通过原后台事件播报结果，避免重复通知。关闭播报时保留文字；中断或失败的播报不会自动重放。

每份报告最多 2,000 字符，每分钟最多接收 20 份、每来源 socket 6 份；归因等待与播报队列各最多 32 份，显示历史最多 100 份。通话结束后地址与关联失效，不重放旧消息；上一通话的报告保留到下一次通话开始。

实现入口为 [`qwen-peer-discovery.ts`](src/adaptor/qwen-peer-discovery.ts)、[`qwen-peer-controller.ts`](src/adaptor/qwen-peer-controller.ts)、[`qwen-peer-reports.ts`](src/adaptor/qwen-peer-reports.ts) 和 [`session-reports.ts`](src/orchestrator/session-reports.ts)。peer SDK 采用固定版本的[官方 Node-only 源码](src/vendor/qwen-code-peer/README.md)并校验来源；peer 传输支持 macOS/Linux，完整桌面体验仍要求 macOS。当前终端协议测试基线为 Qwen Code 0.23.3，不代表任意旧版本具备这些能力。完整条件、协议限制与验收步骤见 [M3 验收清单](../../docs/m3-acceptance.md)。

## 协议与能力边界

### 模型工具与 MCP

主 Omni 通过 daemon 定义的工具使用 Appshot、Memory、Proactive 和任务委托，不直接获得后台编程助手的全部工具。

本包没有独立的 MCP 服务配置或管理层。MCP 应在后台 Harness 中配置，能否在 ACP 会话中使用由后台实现决定；当前 ACP 创建／加载会话传入的是 `mcpServers: []`。新增 MCP 接入不能仅修改 Realtime 工具说明，还需要明确实际执行与授权通道。

无论是否接入后台，主助手都以 **Qwen Omni** 为身份。无需外部信息的日常对话直接回答；简单的公开信息查询优先使用 `web_search`。文件操作、命令执行、复杂任务，以及用户明确交给编程助手的工作，通过 Harness 处理。

无论是否接入后台，都可以使用 `web_search`，客户端不限制可用的模型名称。独立的纯文本 Realtime 搜索连接复用主会话的 model（包括别名）、endpoint 和 API key，不单独配置搜索模型；原生搜索是否可用取决于服务端。实现见 [`src/realtime/web-search.ts`](src/realtime/web-search.ts)。

工具立即返回 `accepted + taskId`。搜索任务独立执行，可并行处理多个查询，每个查询的超时为 25 秒。请求只包含本次查询，不附带麦克风音频、截图、Memory 或其他工作会话上下文。是否实际进行了搜索由服务端元数据判断；未知状态不代表已确认联网搜索。

完成结果进入 Injector 的 `search_result` 通道，等待用户讲话、前台响应和设备播放结束，再由主 Omni 根据 query／answer／searchStatus 组织回答，不逐字朗读原始结果。结果作为引用数据放入 `[NOTIFICATION]` user 上下文消息，不是用户的新请求。对应响应没有工具权限，网页内容不能授权再次搜索、委托任务或修改 Memory。搜索以 `kind: "search"` 的子智能体任务显示，可单独取消，并区分等待播报和播报完成。

主会话的系统指令在整场通话中保持固定，每条连接只在 `session.update` 中发送一次，`response.create` 不重复或覆盖。子智能体结果通过 `conversation.item.create` 发送，作为带类型标记的引用数据。Memory 更新使用可替换的 `[MEMORY_CONTEXT]` user 快照；关闭时发送不含旧数据的禁用快照，而不是改写系统提示词。重连只恢复最新快照，工具列表变化则通过仅含 tools 的 `session.update` 更新。服务端当前会话中已存在的旧消息不会因此被删除。

工具只在 `response.done` 确认 completed，并核对最终 ID、名称、参数和状态后执行；结果得到服务端确认后才继续响应。能关联到待确认回执的 `Unknown function call id`，或 10 秒结果确认超时，会停止该续答链并记录静默诊断，不重复执行动作，也不直接关闭通话。无法关联的协议或配置错误仍按各自的失败逻辑处理。回执被拒绝不能说明任务是否已执行，也不授权重新执行。

异步任务的受理回执需要单独完成一轮 `tool_continuation`。搜索、Appshot 画面分析、托管 handoff 或 Proactive 创建回执得到服务端确认后，daemon 会等待这轮响应结束，再注入最终的视觉、搜索、后台或 Monitor 通知。这样将任务受理与结果播报分开处理，不重复执行任务，也不改写系统指令。

只有工具链已产生音频铺垫，且**父响应里的所有工具**都成功受理了符合条件的异步任务时，才跳过重复确认音频。适用范围是 `web_search`、已受理的 Appshot 画面分析、不含警告的托管 `handoff`，以及已提交创建的 `create_proactive_monitor`／`create_live_narration`。模型仍完成回执响应；文字保留在服务端历史和带 `audioSuppressed:true` 的诊断转写中，但不作为用户听到的对话写入 Memory、后续委托上下文或重连历史。没有音频铺垫、存在错误或警告，或混有查询工具时，确认照常播报。终端指令投递、权限答复、`session_create`、定时器和任务更新／取消不适用。若迟到回执所属的轮次已被新的用户发言取代，则单独静默收完该回执，不沿用旧轮次的工具权限；这不会静音对新发言的回答或最终任务结果通知。

如果回执续答再次发出相同的已受理请求，运行时返回原回执，不启动第二个任务。该保护只作用于这轮续答；同一工具链中的不同请求，以及用户新提出的请求仍可执行。复用时保留原回执中的警告。

原生搜索失败（包括服务端拒绝）后，如果已配置后台，运行时会在默认后台新建隔离会话，只传入原查询和只读公开信息查询约束，沿用现有的 handoff、任务记录和权限流程。失败输出或网页指令不构成授权，主模型也不会重复发起转交。没有后台时，搜索报告失败。原搜索记录转交情况，后台任务按实际事件更新。结束通话或新建对话会取消未完成搜索、撤回待播结果，并停止该通话自动转交的查询；其他后台任务按原生命周期运行。发出停止请求后，仍需等待后台确认。

### 语音与视觉

主会话请求 `semantic_vad`、`create_response: false` 和 `interrupt_response: true`：服务端识别轮次，daemon 调度 `response.create`。Memory 更新和工具续答保持主会话的 VAD 模式不变。独立 Monitor 手动提交媒体片段，搜索只使用文本；它们的 `turn_detection: null` 不会关闭主会话的 VAD。

音频传输使用单声道 PCM16，麦克风输入为 16 kHz，**模型输出为 24 kHz**（`session.audio.output.format.sample_rate: 24000`）。Host 将输出重采样到设备的实际采样率；不要为了适配模型而强制切换系统输出设备的时钟。更新后需重启两端，可通过 `session.start.outputSampleRate` 检查本次通话的播放输入采样率。

视觉输入只有一个选定来源和一种采集模式：

| 路径               | 送入内容与范围                                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| Live Feed          | 连续向主 Omni 发送所选摄像头或所选显示器的完整画面                               |
| On Demand Appshot  | 截图由独立的画面分析子智能体读取；主模型收到文字证据和资产／元数据回执           |
| Proactive 视觉监控 | 向独立 Monitor 发送所选摄像头或完整显示器画面；On Demand 下也可独立采样          |
| 可选视觉 Memory    | Live Feed 复用当前帧；On Demand 独立采集选定显示器或摄像头，存储整理后的观察文字 |

Appshot 截图后，通过 `function_call_output` 返回带资产句柄的异步 `accepted + taskId` 回执。`kind: "visual"` 的画面分析子智能体复用主模型、endpoint 和 key 分析编码截图，不使用工具或联网搜索，再通过无工具权限的 `visual_result` 通知将结果交回主 Omni。这条路径不需要后台 Harness；主对话收到的是文字证据，不是图片本身，资产句柄也不能单独提供视觉证据。

视觉子智能体依次发送两组“一秒协议静音＋同一张 JPEG”，只 commit 一次。收到确认后，通过 `response.instructions` 提交视觉问题并请求文字推理。重复静态帧用于满足视频输入格式，不表示画面发生了变化。固定系统提示词只发送一次，不附带私人 Memory 或无关对话。分析超时为 25 秒，停止任务或结束通话会取消分析，失败不会自动转给编程助手。多个分析可并行执行，完成结果共用只读结果 FIFO 和播放确认流程。Subagents 展示排队和运行状态，关闭播报时保留文字结果。屏幕截图保留原始 PNG 资产，模型输入则遵循截图传输限制。

Appshot 的可选参数 `query` 指定当前视觉问题；省略时优先使用本轮最终转写，没有转写时请求概述画面。只有成功受理任务后，才可能跳过重复确认音频。结果提示词要求保留不确定性，不能从 `app=Unknown` 推断桌面为空，也不能将截图文字当成指令、重复已受理请求或编造看不清的细节。`visual.analysis` 和 `visual.delivery` 诊断关联子智能体与主会话响应，不记录图片字节。

协议类型与限制以 [`host/types.ts`](src/host/types.ts)、[`realtime-session.ts`](src/realtime/realtime-session.ts) 及 Host 的共享协议实现为准。当前 Host 协议为 v9：

- 输入和输出绑定通话代次（call epoch），输出还绑定 `outputId`。播放开始、完成和清空时需要保留这些标识，避免旧音频回执推进新的轮次。
- 显示器采集、音频结束标记等扩展通过能力协商（capability negotiation）启用。支持结束标记的 Host 只有在处理完该输出的标记和全部排队音频后，才确认播放完成。
- Proactive 通知等待前台与设备播放结束后按 FIFO 播放；采样可继续、事件可继续入队。任务更新或取消需要撤销其旧事件。
- 采集整个显示器不保证保留原生分辨率。实时帧与单次截图资产采用不同的尺寸和传输限制；更换来源、显示器或 epoch 后，应丢弃晚到的结果。

### 日志与共享文案

使用 `--debug` 关联 Host 连接、epoch、采集尺寸、帧哈希、工具回执和播放时序。会话 JSONL、Memory 数据库和诊断文件用途不同，都可能包含用户对话或任务内容。

搜索结果投递在会话 JSONL 中记录为 `search.delivery`，debug 终端中为 `web_search.delivery`。按任务、服务端 Session 与 response ID 对照 `queued`、`requested`、`response_started`、`transcript`、`audio_started`、`response_done`、`finished` 各阶段。`audio_started` 只表示已向 Host 转交音频，不代表用户已经听到；投递完成还需播放确认。结果响应完成但没有可播放音频时，Subagents 保留结果并显示 `search.answerUnspoken` 对应的“未生成语音答复”状态，同时记录非致命的 `search_answer_unspoken` 诊断，不误报已经播报。

debug 模式还会创建跨连接的[运行归档](#运行归档与离线检查)，与会话 JSONL 和各 Monitor 的归档分别保存。音频、视觉和音视频 Monitor 的归档包含实际请求及原始媒体，只保留最近十个 Monitor 目录；这限制的是目录数量，不是总磁盘用量。结构和诊断方法见 [Monitor 诊断归档](#monitor-诊断归档)，分享前请检查其中的内容。

所有固定 UI 和初始化文案集中在 [`src/i18n/messages.ts`](src/i18n/messages.ts)，使用成对的 `en` / `zh-CN` 字段和一致的占位符。Host 在构建时复用该模块；系统提示词和后台原始输出不属于 UI 翻译表。

## 高级配置参考

本节介绍适配器、调度策略和记忆实现的开发配置。普通用户的编辑步骤和常用示例见[配置与功能指南](../../docs/configuration_ZH.md)。完整校验规则位于 [`config.ts`](src/config.ts) 和 [`memory/config.ts`](src/memory/config.ts)；未填写的字段使用默认值，无需在配置文件中逐项列出。

### 后台启动与兼容配置

初始化向导的编程助手检测规则位于 [`agent-detector.ts`](src/agent-detector.ts)，当前启动入口如下：

| 后台        | 入口                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| Qwen Code   | init 默认可自动启动本地 Qwen Serve；也可连接已有服务或选择 `qwen --acp`           |
| Qoder CLI   | `qodercli --acp`                                                                  |
| Gemini CLI  | `gemini --experimental-acp`                                                       |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp`                                    |
| Codex       | `npx -y @agentclientprotocol/codex-acp`；init 通过 `CODEX_PATH` 指向检测到的程序  |
| Qwen Serve  | REST/SSE 适配器，`kind: "qwen-code"`；`managedServe` 自动启动，或指定已有服务地址 |

ACP 后端的 `command`、字符串数组 `args`、字符串值对象 `env` 与可选 `cwd` 分开配置，不使用 shell 拼接执行。桌面启动优先使用 init 生成的绝对路径；采用 `npx` 的适配器首次运行可能安装依赖。

后端 `name` 长度为 1–32 个字符，以字母或数字开头，可包含字母、数字、下划线和连字符。名称唯一性检查忽略大小写，但引用时应使用配置中的原始拼写。配置多个后端时，必须恰好有一个 `default: true`。默认后端预检失败会阻止启动，其他后端失败则标为不可用。

兼容已有 REST/SSE 服务的配置段：

```json
{
  "backends": [
    {
      "name": "qwen-server",
      "kind": "qwen-code",
      "serveUrl": "http://127.0.0.1:4170",
      "default": true
    }
  ]
}
```

服务需要认证时另外设置 `token`；`baseUrl` 是 `serveUrl` 的另一种写法。此类后端不使用 ACP 的进程配置字段。省略 `backends` 会选择默认的本机 `qwen serve` 连接，关闭后台必须显式使用 `[]`。

### ACP 授权模式

ACP 后端可选 `sessionMode`，值必须与该后端在 `session/new` 返回的 `availableModes` 中某个 `id` **精确匹配**。它是后端定义的模式名，不是 Live 通用的“免审批”布尔开关，也不适用于 `kind: "qwen-code"` 的 Serve 条目。

未配置或找不到指定 ID 时，Live 会尝试选择后端提供的询问授权模式：优先查找 `default`，其次是名称为 `Ask for approval` 的 `read-only`。指定 ID 不存在时会给出警告。如果两者都不可用，或 `setSessionMode` 失败，后端会保留自己的模式，因此**不能保证每项操作都需手动审批**。

模式的实际权限由后端决定，需要核对其文档和最终选中状态。当前日志会将成功设置的任意显式 `sessionMode` 描述为“不逐项审批”，这不能准确反映实际权限；选择 `default` 也不意味着不受限制。相关测试应覆盖有效和无效 ID、缺少模式、切换失败以及权限转发。

### 语音授权与持续允许

权限询问由主 Omni 按当前用户对话的语言生成；无法判断时才使用 `config.language`。后台返回的英文标题、命令和路径只是待审批数据，不决定播报语言，也不代表用户授权。独立的权限询问响应不能调用工具，也不能用进度播报代替询问。用户随后明确答复，再由正常对话调用 `respond_permission`；原始操作保留在子智能体详情中。

任务完成／失败通知使用独立 `task_result` 响应。运行时提供真实状态、任务和摘要，模型按当前对话语言简短概括，不朗读内部 ID、原始路径或 Markdown，也不能借通知调用工具。最近的真实用户语言样本可以跨通话保留，但只用于选择语言，不能当作该任务的结果事实。通知消息携带可信语言元数据，不修改系统指令；如果之后有新的真实用户发言，合并回复遵循该发言的语言。

后台提出真实权限请求后，普通 `allow` 只批准当前请求。只有用户明确表示“以后都允许”等持续授权意图，才使用 `allow_always`；这适用于支持权限转发的 ACP 和 Qwen Serve 后端。

`allow_always` 优先选择后端提供的持久授权，由后端保存实际权限范围，例如“允许全部文件编辑”或“在当前项目中始终允许此命令”。有多个持久选项时采用后端提供的首个选项；Qwen 的项目级选项先于用户级选项，不能把它理解为无条件允许所有操作。

如果后端未提供、或为当前请求隐藏了持久选项，就退回单次允许，而不是拒绝；仅在这种情况下，Live 还会为当前会话保留 **30 分钟、只匹配相同动作**的本地允许规则。它不涵盖只是相似的其他操作。

后续明确的 `deny` 会撤销匹配的 Live 本地规则，但不会撤回后端已经保存的持久授权；后者必须在对应后端中清除，也不受 Live 的 30 分钟规则约束。

### Proactive 调优参数

调度器按**每段 2 秒、视觉输入固定 1 FPS**向独立 Monitor 提交新媒体。采集、推理和前台播报是不同阶段；提高调度检查频率，不能让不完整片段提前就绪，也不能消除网络、模型和播放延迟。

`create_proactive_monitor` 创建条件观察任务，`create_proactive_timer` 创建时间提醒，`create_live_narration` 持续描述有意义的变化。创建解说只接受三个字段：`title`、`modalities` 和 `narration_focus`。运行时将任务绑定到原始真实用户请求，并把适用于该任务的语言、语气和详细程度偏好传递到 Monitor 判断与播报；其他任务的偏好不能扩大此任务范围，用户要求描述的内容也不等于已观察到的事实。通过任务更新工具明确设置 `narration_style` 时，它覆盖冲突的风格偏好。取消或更新任务会使先前任务代次的排队事件失效。

| 字段，均位于 `proactive`               | 默认值     | 说明                                                                        |
| -------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `enabled`                              | `true`     | 是否启用工具与监控能力                                                      |
| `monitor.sessionRecycleEvals`          | `60`       | 一条 Monitor 连接达到此推理次数后重建连接                                   |
| `monitor.representationCompact`        | `"normal"` | 视觉 Monitor 的视频表征聚合模式：`normal` 或 `none`；不作用于纯音频 Monitor |
| `scheduler.evalIntervalSec`            | `1`        | 检查是否可以发起下一次推理的间隔，秒                                        |
| `scheduler.maxFailuresPerTask`         | `3`        | 连续推理失败达到此次数后停止该任务                                          |
| `scheduler.repeat.cooldownSec`         | `3`        | 重复触发的冷却时间，秒                                                      |
| `scheduler.repeat.maxWaitTtsSec`       | `30`       | 每次尝试从准备到播放完成确认的上限，含兜底生成／播放；不限制前面的排队时间  |
| `scheduler.repeat.clearBufferOnResume` | `true`     | 恢复观察时清理旧采集缓冲区                                                  |
| `vision.windowSizeSec`                 | `10`       | 本地新画面的暂存时长上限，秒；不是每轮重发的历史窗口                        |
| `vision.minEvalDurationSec`            | `0`        | 首次推理前的额外视觉观察时长；`0` 仍需完整片段和至少两张有效新帧            |
| `audio.windowSizeSec`                  | `60`       | 本地新音频的暂存时长上限，秒                                                |
| `audio.minEvalDurationSec`             | `0`        | 首次推理前的音频观察时长                                                    |

两个缓冲窗口都不能短于 2 秒，最短观察时长不能超过对应窗口。Monitor 帧率和片段时长是固定协议常量，不是配置项；前台 Live Feed 使用独立的 `visualInput.fps` 设置。采集中断较久时，会重新计算连续观察时长。不完整片段会被跳过，已分析过的画面不计作新证据。

各模态的 Monitor 都使用交错的流式缓冲区会话。每条连接只在初始 `session.update` 中设置固定系统指令、`turn_detection: null`、`smooth_output: false` 和空工具列表。每轮追加新音频，视觉监控还会追加新图像，然后发送 `input_audio_buffer.commit`。收到 `input_audio_buffer.committed` 后请求推理，等 `response.done` 后再提交下一片段。服务端保留之前的 user 媒体和 assistant 回复，客户端不重建或重复发送这些历史。

只有 Monitor 连接的首个媒体请求附带任务文字，格式为 `{"type":"response.create","response":{"instructions":"TASK_TEXT"}}`。这里的 `response.instructions` 指定首轮 user 媒体对应的任务，不是 Monitor 的系统提示词。后续片段直接发送不含该字段的 `response.create`，也不单独发送只有任务文字的 `conversation.item.create`。重建连接时，任务文字随首个新媒体片段再次发送，不重放旧媒体。独立的 On Demand 画面分析也用该字段提交一次视觉问题。这两条都是手动提交媒体的推理路径；前台对话、工具续答、结果通知和 Web Search 不携带 response 级 instructions。

每个纯音频片段包含 2 秒 PCM16／16 kHz／单声道音频，不额外补静音。纯视频片段依次 append 1 秒 `protocol_silence` 静音、一张新图、第二秒静音、第二张新图，然后只 commit 一次，不包含麦克风声音。音视频片段按相同顺序提交两段真实的 1 秒麦克风音频及其对应画面；每个视觉轮次因此包含同一两秒时段内的两张新图。图像不足时不复制此前画面，不完整片段会记录丢弃原因。

等待推理完成时，新媒体暂存在有容量限制的本地队列中，不再追加到正在推理的服务端缓冲区，也不把积压片段合并成一轮更长的输入。重建连接会丢失该连接的模型历史；只保留尚未提交的新媒体，不重放已分析过的声音或画面。调试时用 `transportGeneration` 区分不同连接的历史。

`monitor.representationCompact` 映射到 `session.video.input.representation_compact`，在 Monitor 初始 `session.update` 中设置，早于第一段音频（包括协议静音）。该值在连接内不变，定期重建或故障恢复时继续使用相同配置。修改配置后重启服务；需要保留更多画面细节时，可使用 `none`。

Monitor 没有任务数量上限的配置项；实际并发能力仍受设备资源、采样、模型延迟和播报队列限制。

#### Proactive 独立播报兜底

前台 Proactive 响应以 `status: completed` 正常结束却未产生音频时，包括返回 `remain_silent` 的情况，同一次通知最多使用 **一次**独立播报兜底。它不创建新 Monitor、不增加触发次数，也不重新判断证据。失败或被取消的前台响应不满足这项兜底条件。

如果调用了 `remain_silent`，需先回传结果、等待确认，并完成静默回执续答。随后，兜底播报进入 Injector 的 FIFO 队列，等待前台响应和播放结束。它复用主会话的 endpoint、模型、key 和音色，输出 24 kHz PCM，并设置 `smooth_output:false`、无工具／搜索、`turn_detection:null`。请求只包含简短固定规则、引用的观察摘要和当前对话语言，不包含原始媒体、Memory、待监测条件或干预指令。这一步只负责播报，不重新核实观察事实；其 `response.create` 不携带 instructions。

兜底会先缓冲完整且生成成功的音频，再交给 Host 播放。请求超时为 20 秒，PCM 上限为 20 秒单声道音频（960,000 字节）。`maxWaitTtsSec` 限制这次尝试从准备到播放完成的总时长，不会因兜底而延长；配置更短时，可能先达到该上限。兜底失败或超时只将本次播报记为 `undelivered`，不会让重复监控任务进入失败状态。

独立兜底的播报状态与任务状态分开：

| 播报状态      | 含义                                             |
| ------------- | ------------------------------------------------ |
| `queued`      | 按顺序等待，包括等待尚未完成的回执续答或连接恢复 |
| `preparing`   | 正在准备响应；已生成／缓冲音频不代表开始播放     |
| `speaking`    | Host 已实际确认开始播放                          |
| `delivered`   | 生成成功，并已收到 Host 播放完成确认             |
| `undelivered` | 本次通知未完整送达，不能表示用户已经听到         |

一次性任务可能显示 `completed`，但其播报为 `undelivered`：检测已结束，通知却未播完。重复监控在一次兜底播报失败后仍会继续。用户说话、关闭播报、取消任务或结束通话都会撤销排队中的兜底。连接恢复时，尚未开始的兜底可以继续等待回执流程完成；一旦开始生成或播放，打断、静音、取消、停止或连接恢复都会将它中止，不重播旧通知。

主通路用 `preparing` 和 `speaking` 区分生成和实际播放。关闭播报时，事件可能直接标为已处理，重新开启后不会补播。此时的已处理／已完成状态**不代表用户听到了声音**；上表中 `delivered` 的严格条件只适用于独立兜底。debug 事件 `proactive.fallback_queued`、`proactive.fallback_started`、`proactive.fallback_audio_ready`、`proactive.fallback_delivered`、`proactive.fallback_undelivered` 和 `proactive.delivery_undelivered` 使用同一 task／delivery ID 关联，不增加触发次数。

### Memory 模型服务连接

整理器（Updater）负责从对话中整理长期和近期记忆；可选的观察器（Observer）独立从视觉输入生成环境记忆。两条路径相互独立：Updater 不生成环境观察记录，关闭它也不会删除环境记忆或禁用观察采集、环境检索。

记忆整理和视觉观察默认使用由 Realtime endpoint 派生的同地域 `/compatible-mode/v1/chat/completions`，向量检索使用 `/compatible-mode/v1/embeddings`。整理模型默认为 `qwen3.7-plus`；未配置 `observer.model` 时沿用整理模型。视觉观察要求模型支持图片输入。

`updater.baseUrl` / `observer.baseUrl` 可分别指定 HTTP(S) 兼容接口的基础地址，不包含 `/chat/completions` 后缀。`apiKeyEnv` 填写存放凭据的环境变量名，需与对应的 `baseUrl` 一起配置。即使使用自定义地址，`apiKeyEnv` 为空时仍会发送主 API key，因此应确认该服务可以接收这份凭据。Embedding 始终使用主 DashScope 连接。

### Memory 调优参数

以下路径都位于 `memory` 内。省略的字段自动使用表中默认值；通常只需调整开关、模型、目录和视觉观察间隔。上下文数量／字符上限不等于删除本地历史或限制整个数据库大小。

| 字段                                      | 默认值               | 用途                           |
| ----------------------------------------- | -------------------- | ------------------------------ |
| `enabled`                                 | `true`               | Memory 总开关                  |
| `dir`                                     | `""`                 | 空值使用 `<数据目录>/memories` |
| `defaultId`                               | `"default"`          | 选中的记忆库 ID                |
| `updater.enabled`                         | `true`               | 通话结束后的长期／近期记忆整理 |
| `updater.model`                           | `"qwen3.7-plus"`     | 整理模型                       |
| `updater.baseUrl` / `updater.apiKeyEnv`   | `""` / `""`          | 可选的自定义连接设置           |
| `updater.timeoutMs`                       | `120000`             | 单次整理请求超时，毫秒         |
| `updater.temperature`                     | `0`                  | 整理生成温度                   |
| `updater.maxTokens`                       | `2048`               | 整理输出 token 上限            |
| `updater.maxWmEntries`                    | `64`                 | 单次整理处理的工作记忆条目上限 |
| `updater.shutdownWaitSec`                 | `2`                  | 退出时等待整理完成的时长，秒   |
| `observer.enabled`                        | `false`              | 视觉记忆开关                   |
| `observer.model`                          | 跟随 `updater.model` | 支持图片输入的观察模型         |
| `observer.baseUrl` / `observer.apiKeyEnv` | `""` / `""`          | 可选的观察模型连接设置         |
| `observer.intervalSec`                    | `60`                 | 视觉观察间隔，秒               |
| `observer.timeoutMs`                      | `60000`              | 单次观察请求超时，毫秒         |
| `observer.temperature`                    | `0`                  | 观察生成温度                   |
| `observer.maxTokens`                      | `400`                | 观察输出 token 上限            |
| `observer.maxContentChars`                | `400`                | 保存的描述长度上限             |
| `observer.maxFrameAgeSec`                 | `15`                 | 接受的观察帧最大年龄，秒       |
| `wm.maxEntries` / `wm.maxEntryChars`      | `128` / `200`        | 工作记忆条目数／每条字符上限   |
| `segment.maxTurns`                        | `4`                  | 对话分段轮次上限               |
| `segment.minTurnsBeforeGapCut`            | `2`                  | 按静默间隔切段前的最少轮次     |
| `segment.maxChars`                        | `1000`               | 对话分段字符阈值               |
| `segment.silenceGapSec`                   | `60`                 | 用于切段的静默间隔，秒         |

检索参数：

| 字段                                      | 默认值                | 用途                                                         |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------ |
| `retrieve.topK`                           | `3`                   | 检索结果数量上限                                             |
| `retrieve.maxChars`                       | `5000`                | 原始结果正文的字符上限                                       |
| `retrieve.retrievedMaxChars`              | `6000`                | 加入模型上下文后的检索区字符上限                             |
| `retrieve.useVector`                      | `true`                | 启用向量与关键词混合检索                                     |
| `retrieve.model`                          | `"text-embedding-v4"` | Embedding 模型                                               |
| `retrieve.timeoutMs`                      | `400`                 | 实时查询向量请求超时，毫秒                                   |
| `retrieve.backfillTimeoutMs`              | `10000`               | 后台补建向量超时，毫秒                                       |
| `retrieve.cacheSize`                      | `1000`                | 向量缓存容量                                                 |
| `retrieve.minSim`                         | `0.4`                 | 向量候选相似度阈值                                           |
| `retrieve.vecLimit` / `retrieve.ftsLimit` | `50` / `50`           | 向量／全文索引候选数量                                       |
| `retrieve.ftsAndTryThreshold`             | `20`                  | OR 关键词命中较多时，进一步尝试 AND 匹配的阈值               |
| `retrieve.andBoost`                       | `1.2`                 | AND 命中加权                                                 |
| `retrieve.timeRangeBoost`                 | `2`                   | 时间范围内的候选加权                                         |
| `retrieve.timeEdgeDays`                   | `2`                   | 时间范围边缘的宽限天数                                       |
| `retrieve.rrfK`                           | `60`                  | 倒数排名融合（RRF）参数                                      |
| `retrieve.envMinGapSec`                   | `600`                 | 检索视觉观察时的最小时间间隔，用于避免重复结果；不是采样间隔 |

预载参数：

| 字段                                               | 默认值      | 用途                                                 |
| -------------------------------------------------- | ----------- | ---------------------------------------------------- |
| `preload.ltmMaxPerField`                           | `6`         | 长期记忆每个字段的预载条目上限；单值字段仍只取一个   |
| `preload.ltmMaxChars`                              | `800`       | 预载长期记忆字符预算                                 |
| `preload.stmUpcomingGraceDays`                     | `2`         | 未设置明确到期时间的未来事项，其事件日期后的宽限天数 |
| `preload.stmMaxAgeDays`                            | `90`        | 近期事项的最大保留活跃天数                           |
| `preload.recencyLambda`                            | `0.05`      | 近期事项的时间衰减系数                               |
| `preload.upcomingWeight` / `preload.ongoingWeight` | `1.5` / `1` | 未来／进行中事项的基础权重                           |
| `preload.urgentBoost` / `preload.urgentDays`       | `1.5` / `3` | 临近事项加权及其天数范围                             |
| `preload.stmMaxItems`                              | `20`        | 预载近期事项数量上限                                 |
| `preload.stmMaxChars`                              | `1200`      | 预载近期事项字符预算                                 |

`retrieve.maxChars` 不能大于 `retrieve.retrievedMaxChars`；`retrieve.backfillTimeoutMs` 不能小于 `retrieve.timeoutMs`；`segment.minTurnsBeforeGapCut` 不能大于 `segment.maxTurns`。完整取值范围见 [Memory 配置校验](src/memory/config.ts)。

### 环境变量参考

总体优先级为：**环境变量 → `config.json` → 内置默认值**。API key 按 `DASHSCOPE_API_KEY` → `QWEN_LIVE_HARNESS_REALTIME_API_KEY` → `realtimeApiKey` 的顺序读取。如果修改配置文件后没有生效，先检查 shell 中是否设置了覆盖它的环境变量。

| 环境变量                                                  | 对应配置／用途                                         |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `DASHSCOPE_API_KEY`、`QWEN_LIVE_HARNESS_REALTIME_API_KEY` | 主 DashScope key                                       |
| `QWEN_LIVE_HARNESS_REALTIME_ENDPOINT`                     | `realtimeEndpoint`                                     |
| `QWEN_LIVE_HARNESS_REALTIME_MODEL`                        | `realtimeModel`                                        |
| `QWEN_LIVE_HARNESS_VOICE`                                 | `voice`                                                |
| `QWEN_LIVE_HARNESS_BACKENDS`                              | `backends` 的 JSON 字符串；`'[]'` 明确关闭后台         |
| `QWEN_LIVE_HARNESS_CWD`                                   | `defaultCwd`                                           |
| `QWEN_LIVE_HARNESS_SHORTCUT`                              | `shortcut`                                             |
| `QWEN_LIVE_HARNESS_PORT`                                  | `port`                                                 |
| `QWEN_LIVE_HARNESS_DATA_DIR`                              | 配置、会话日志、默认 Memory 的基础目录                 |
| `QWEN_LIVE_HARNESS_DISCOVERY_DIR`                         | daemon 发现目录基础路径；独立于 DATA_DIR               |
| `QWEN_LIVE_HARNESS_DISCOVERY_FILE`                        | 单独启动 Host 时指定完整 `run/daemon.json` 路径        |
| `QWEN_LIVE_HARNESS_VISUAL_SOURCE`                         | `visualInput.source`                                   |
| `QWEN_LIVE_HARNESS_VISUAL_MODE`                           | `visualInput.mode`                                     |
| `QWEN_LIVE_HARNESS_VISUAL_FPS`                            | `visualInput.fps`                                      |
| `QWEN_LIVE_HARNESS_CAMERA_RESOLUTION`                     | `cameraResolution`，例如 `1280x720`                    |
| `QWEN_LIVE_HARNESS_CAMERA_SNAPSHOT_RESOLUTION`            | `cameraSnapshotResolution`，`native` 或 `WIDTHxHEIGHT` |
| `QWEN_LIVE_HARNESS_VISUAL_LIVE_RESOLUTION`                | `liveResolution`，例如 `1280x720`                      |
| `QWEN_LIVE_HARNESS_VISUAL_SNAPSHOT_RESOLUTION`            | `snapshotResolution`，`native` 或 `WIDTHxHEIGHT`       |
| `QWEN_LIVE_HARNESS_PROACTIVE_ENABLED`                     | `proactive.enabled`，接受 `true` / `1` / `false` / `0` |
| `QWEN_LIVE_HARNESS_LOG_LEVEL`                             | `debug` / `info` / `warn` / `error`，默认 `info`       |

省略 `backends` 的配置支持 `serveUrl` / `serveToken`，以及环境变量 `QWEN_LIVE_HARNESS_SERVE_URL` / `QWEN_SERVER_TOKEN`；多后端或无后端模式使用明确的 `backends` 数组。

安装版的桌面启动登记保存 Node.js／CLI 的绝对路径、PATH、配置和发现目录，以及工作目录，不会保存整个 shell 环境。双击 Host 时也需要使用的参数，建议写入配置文件；某个终端中的环境变量未必能被桌面启动的应用读取。

`DATA_DIR` 改变配置与默认数据位置，**不会**自动改变 discovery 基础目录；默认仍为 `~/.qwen-live-harness`。例如，已安装 CLI 可使用独立配置：

```sh
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-work"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
qwen-live-harness init
qwen-live-harness
```

源码开发将这两条 CLI 命令换成 `npm run init` 和 `npm start`。`DATA_DIR` 只能通过环境变量指定，没有对应的 `dataDir` 配置字段；`discoveryDir` 可以写入配置，并被 `QWEN_LIVE_HARNESS_DISCOVERY_DIR` 覆盖。手动配置独立 Host 连接时，将 `QWEN_LIVE_HARNESS_DISCOVERY_FILE` 设为对应完整发现文件路径。

### 运行归档与离线检查

debug 模式将运行归档写入 `<dataDir>/debug/run-*`，与下文系统临时目录中各 Monitor 的归档分别保存。运行归档记录主模型、Monitor、搜索、画面分析、通知播报连接，以及运行和控制事件。已知凭据字段、配置中的密钥和可识别的凭据文本会脱敏，但不会检查图片或音频中的敏感信息。提示词、Memory 上下文、工具参数和结果、转写及媒体仍可能包含隐私，分享前需要检查。

每次归档包含 `manifest.json`、追加写入的 `events.jsonl` 和 `media/`。事件保留全局 `globalSeq`、连接内 `connectionSeq`、连接类型／ID、墙钟时间、单调时间、方向和内容。`archive.connection_registered` 记录连接元数据，不是额外发送的模型请求；实际出站请求记录在 `wire.send` 中。对应 `wire.send_result` 的 `sent` 或 `failed_or_uncertain` 表示本地发送结果；`sent` 只说明 socket 接受了写入，不等于服务端已确认。缺少结果时记为 `unconfirmed`，服务端确认另以入站事件记录。

媒体引用记录相对路径、字节偏移、长度、SHA-256、类型和编码，指向准确的归档字节范围，不是事后重建的录音。会话和配置快照只提供上下文，并不表示每轮都重发了系统指令。判断客户端尝试发送了什么，需要查看实际 wire 序列，并确认归档是否完整。

默认**每次运行的归档上限为 512 MiB**，保留**最近 10 次已结束的运行归档**，包括不完整的归档。运行中的归档不会被清理，总数可能暂时超过十个。`manifest.json` 记录状态（`recording`、`closed` 或 `incomplete`）、警告和计数。达到上限、丢失记录或存储失败会使归档不完整，但不会因此终止通话。写入失败也可能阻止 manifest 更新，因此需要同时检查运行警告和缺失文件；未保存的输入无法事后恢复。

在仓库根目录离线检查一次归档，默认输出不包含提示词或转写正文：

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example
```

从摘要中选择连接 ID，导出到**归档外尚不存在的新目录**：

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example \
  --connection conn-000001 --output /path/to/new-export
```

工具校验事件序号、发送结果、媒体范围及哈希，并拒绝不安全路径或符号链接。摘要列出观察到的连接状态、可用且通过格式校验的服务端 `sess_*` ID，以及去重后的响应数量，不输出消息正文。导出包含 `requests.json`、`responses.json`、选中连接的 `events.jsonl`、复制的媒体片段及检查／manifest 摘要；请求／响应 JSON 中恢复 base64 媒体，原始字节数组使用明确的 `$binary` 包装，脱敏标记也会保留。失败或未确认的发送会保留标记，不完整的归档不会标成完整，也不会覆盖已有输出目录。导出内容仍含隐私，分享前必须检查。

虽然文件名含 replay，这个工具**只做离线检查与导出**，不会读取 API key、联网、启动设备，或执行记录中的函数调用和后台命令。工具历史仅作为数据供分析，不会被执行。归档也不能保证后续请求产生相同的模型输出或服务端状态。

### Monitor 诊断归档

使用 daemon `--debug` 或 `QWEN_LIVE_HARNESS_LOG_LEVEL=debug` 时，纯音频、纯视觉和音视频组合 Monitor 都会将实际请求保存在系统临时目录。非 debug 启动不创建这些媒体归档，之前未保存的音频／画面无法追补。源码启动命令为：

```sh
npm start -- --debug
```

归档不是连续录音／录像，而是按每轮推理组织的 JPEG、WAV 与 JSON：

```text
qwen-live-harness-monitor-debug/
  monitor-<time>-<id>/
    monitor.json
    requests/000001/
      request.json
      image-0001.jpg   # 仅该轮含图像时存在
      input.wav
      response.json
```

- `proactive.monitor_debug_started` 和 `proactive.monitor_request_saved` 记录绝对目录。一次 Monitor 的 WebSocket 回收重建仍使用同一目录。
- JPEG 是成功写入模型连接的帧。`input.wav` 保存 commit 前成功 append、且未被 `input_audio_buffer.clear` 丢弃的单声道 16 kHz PCM16，按发送顺序拼接，包含协议静音。它不是原始麦克风全程录音；归档中的音频偏移不包含 WAV 文件头。
- 所有模态的 `request.json.events` 都按顺序保存音频／图像 append、`input_audio_buffer.commit` 和 `response.create` 事件。每条音频 append 指向 `input.wav`，记录字节偏移、长度和 `origin`。`microphone` 表示麦克风音频，`protocol_silence` 表示纯视频协议需要的静音音轨，`unknown` 表示来源未标注。`audioSummary` 提供 `totalBytes`、`microphoneBytes`、`protocolSilenceBytes` 和 `unknownBytes`。这些诊断字段不发送给模型，也不表示音频能量或检测到的事件。握手或等待推理期间缓存的媒体可能延后发送，因此发送时间不一定是采集时间。
- `request.json` 保存初始化配置、事件顺序、帧哈希、音频偏移和 `previousRequest`。任务文字位于首轮 `response.create` 的 `response.instructions` 中，后续请求不包含该字段，也没有单独的任务 user 消息。`transportGeneration` 区分同一 Monitor 的不同连接，`previousRequest` 只关联当前连接内的上一请求，重建连接后会重置。服务端会话还可能保留之前提交的媒体和回复，因此当前 WAV 不是模型的全部上下文；排查时需要结合连接和前序请求。
- `request.json.session` 附带初始化快照，便于单独检查文件，不表示本轮重发了系统提示词或任务文字。同一连接的快照使用相同事件 ID；实际增量发送顺序记录在 `events` 中：媒体 append、commit，收到确认后再发送 `response.create`。只有新建连接时才重新发送初始化。任务文字随该连接的首次媒体推理请求提交一次，系统提示词只在初始 `session.update` 中设置。
- 可用且格式有效的 `providerSessionId` 会写入对应连接的 request／response JSON。`response.json` 保存原始动作文本和解析结果，并保留服务端提供的 `responseId`、`eventId` 和 `usage`；请求事件也会保留可用的发送事件 ID。缺失标识应保持缺失，不应猜补；服务端 usage 也不等于有效麦克风时长。
- 对照 Host、daemon 和 `proactive.monitor_image_sent` 的 `frameHash`；`proactive.monitor_commit` 的计数只包含成功 socket 写入，`proactive.monitor_committed` 对应服务端确认。队列中或已丢弃的帧不能当作已发送证据。
- `proactive.monitor_chunk_prepared` 记录片段采集时间范围和真实发送帧数；`proactive.monitor_chunk_dropped` 记录缺图、采集间断、未提交片段失效或媒体／commit 发送不确定等原因。`proactive.monitor_input_dropped` 聚合本地缓存淘汰的数量、字节和时间范围。上述事件在 debug 模式下进入会话 JSONL，帮助区分“没有完整输入”和“模型判断为 wait”。
- `proactive.monitor_ready` 标注输入通路为 `streaming_buffers`；`proactive.monitor_response_requested` 的 `taskTextIncluded` 只在每条连接的首次媒体推理时为 true，用于区分一次性的任务文字与固定的系统提示词。
- 所有模态合计保留最近创建的 **10 个 Monitor 目录**。这限制的是目录数量，不是每种模态的数量、请求次数或总磁盘用量。归档被清理后，Monitor 继续运行，但不再写入归档。目录和文件使用私有权限，待处理与排队写入的内存上限为 32 MiB；磁盘错误或超过上限可能使归档不完整，但不会因此中断通话。
- JSON 会清理连接凭据字段和已知 API key，但声音、画面及用户文字中的其他敏感信息不会自动脱敏。分享前请检查 WAV、JPEG 和 JSON，而不只是终端日志；不要直接发送整个数据目录。

#### 调度决策与会话 JSONL

媒体归档只说明实际送入某次推理的内容；冷却期间没有送入 Monitor 的音频不会出现在 WAV 中。以 debug 启动时，关键 Proactive 元数据还会同时打印到终端，并保存到 `<dataDir>/sessions/` 下的会话 JSONL，记录的 `type` 为 `proactive.debug`，`payload.event` 为具体事件名：

- `proactive.monitor_commit`／`proactive.monitor_committed`／`proactive.monitor_result`：对应输入提交、服务端确认和推理结果。
- `proactive.evaluation_decision`：例如 `notification_accepted`、`suppressed_awaiting_false`、`rearmed_false`、`ignored_cooldown`，用于区分“模型触发了”与“调度器允许通知”。
- `proactive.cooldown_started`／`proactive.cooldown_resumed`／`proactive.cooldown_audio_dropped` 和 `proactive.buffer_reset`：说明冷却、期间丢弃的音频统计及待提交缓存清理，不是另外保存了被丢弃的原始声音。

关联事件时，先匹配 `taskId` 和任务代次（Monitor 事件为 `taskGeneration`，部分调度事件为 `generation`），再对照相邻结果的 `evaluation`、`transportGeneration` 和可用的 `providerSessionId`／`responseId`。并非每个事件都带齐这些标识，仅凭时间接近可能会混淆任务或连接。该 JSONL 通道只保存有大小限制的诊断元数据，不保存逐帧音频或图像，也不会补录 debug 开启前的内容。

详细实现见 [`monitor-debug-store.ts`](src/proactive/monitor-debug-store.ts)。Host 自身的私有故障日志与设备诊断见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md#日志与文案)。

## 打包与发布

仓库根 workspace 标记为 `private`，不发布到 npm；实际发布的是本目录的 `qwen-live-harness` 包。安装包包含构建后的 `dist` 和许可证，不包含 Electron Host，`npm run check:package` 会验证这项包边界。

公开 npm 包与签名 Host 需要匹配版本和协议。构建、签名、公证、GitHub Release、OSS 同步及 npm 发布的维护入口见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md)；日常源码调试不需要发布或修改安装器信任规则。

许可证：[Apache License 2.0](../../LICENSE)。
