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

- [CLI／配置](src)：`index.ts`、`cli-startup.ts`、`config.ts`、`init.ts`；`peer-setup.ts` 和 `peer-diagnostics.ts` 负责终端设置。
- [Daemon](src/daemon.ts)／[Host 协议](src/host)：组装服务、发现文件、传输和清理。
- [Orchestrator](src/orchestrator)／[Realtime](src/realtime)：通话生命周期、提示词、模型子任务、响应与结果调度。
- [Adapters](src/adaptor)：后端能力、ACP、Qwen Serve 和 peer 协议。
- [Tools](src/tools)／[Permissions](src/permissions)／[Subagents](src/subagents)：工具定义、句柄、授权和任务管理。
- [Proactive](src/proactive)／[Memory](src/memory)／[Logs](src/log)：监控、存储检索和诊断。
- [messages.ts](src/i18n/messages.ts)：CLI 与 Host 共用的中英文固定文案。

主调用链是 `LiveDaemon → LiveHostCoordinator → LiveSession → Realtime / BackendAdaptor`。Qwen Serve 是可选 REST/SSE 后端，ACP 和无后台模式不依赖它。

## 构建与测试

在仓库根目录运行：

```bash
npm run build
npm run typecheck
npm test
npm run lint:all
npm run format:check
npm run check:boundaries
npm run check:package
```

`npm test` 包含 daemon、脚本和集成测试，**不包含 Host 测试**。`npm run lint` 检查 daemon／集成测试／脚本；`lint:host` 检查 Host，`lint:all` 执行两者。修改 Host 或共享模块时，还需运行 `npm run typecheck:host`、`npm run test:host` 和 `npm run build:host`，见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md)。

只运行一个 daemon 测试：

```bash
npm test --workspace qwen-live-harness -- src/orchestrator/live-session.test.ts
```

默认测试使用替身和本地服务，不调用模型账号或设备。`check:package` 会在临时目录生成、安装实际 npm tarball，可能访问 npm。真实后端／模型／设备检查需单独进行，自动夹具不得使用个人凭据、会话或授权。

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

报告播报会等待用户讲话、前台回复和设备播放结束，再通过独立、用后关闭且不带工具或搜索的语音连接转述。报告不是新的用户指令、授权答复或经过验证的任务完成事件。关联的托管任务仍通过原后台事件播报结果，避免重复通知。关闭播报时保留文字；中断或失败的播报不会自动重放。

每份报告最多 2,000 字符，每分钟最多接收 20 份、每来源 socket 6 份；归因等待与播报队列各最多 32 份，显示历史最多 100 份。通话结束后地址与关联失效，不重放旧消息；上一通话的报告保留到下一次通话开始。

实现入口为 [`qwen-peer-discovery.ts`](src/adaptor/qwen-peer-discovery.ts)、[`qwen-peer-controller.ts`](src/adaptor/qwen-peer-controller.ts)、[`qwen-peer-reports.ts`](src/adaptor/qwen-peer-reports.ts) 和 [`session-reports.ts`](src/orchestrator/session-reports.ts)。peer SDK 采用固定版本的[官方 Node-only 源码](src/vendor/qwen-code-peer/README.md)并校验来源；peer 传输支持 macOS/Linux，完整桌面体验仍要求 macOS。当前终端协议测试基线为 Qwen Code 0.23.3，不代表任意旧版本具备这些能力。集成验证见下文。

### 终端集成验证

使用隔离的 Live／Qwen 数据目录和测试 controller 授权。协议测试可运行真实 Qwen CLI，模型、Realtime 和 Host 使用本地替身：

```bash
TEST_CLI_PATH=/absolute/path/to/qwen/cli.js npm run test:backends -- qwen-live-harness-m3-discovery qwen-peer-instructions qwen-peer-reports
```

用配套的 Host 与 daemon 构建进行手工验收：

1. 运行 `init --peers` 和 `doctor --peers`，确认已有后端／默认项不变，发送授权与报告开关相互独立。
2. 发现两个测试 Qwen 终端，准确选择目标发送，覆盖 delivered、held、denied/refused 和 unknown；送达不等于执行。
3. 发送报告，验证来源归属、FIFO 播报、静音／打断，以及并行运行的托管／ACP 任务与授权流程。
4. 结束通话但保留终端工作，确认旧地址及待播消息失效；重新通话后关闭发现功能，确认其他后端仍可用。
5. 只撤销测试授权、停止测试进程，记录 commit、Qwen／Node 版本、构建、命令和实际结果。

协议测试、安装、UI、真实音频与生产模型行为分别记录；测试通过或连接成功不代表完整语音验收。

## 协议与能力边界

### 模型工具与 MCP

主 Omni 以 **Qwen Omni** 为身份，使用 daemon 定义的工具，不直接获得后台全部工具。普通对话直接回答，公开信息查询优先用 `web_search`，文件操作、命令、复杂工作或明确交给编程助手的任务通过后台处理。MCP 在后台 Harness 中配置；ACP 创建／加载会话目前传入 `mcpServers: []`。增加 MCP 需要实际执行与授权通道，不能只改提示词。

`web_search` 立即返回 `accepted + taskId`，以纯文本连接复用主模型完整 ID、endpoint 和 key，没有模型白名单或独立模型配置。查询可并行，每次超时 25 秒；不附带麦克风、截图、Memory 或其他任务上下文。服务端元数据区分已确认搜索与未知状态。

搜索失败且配置了后台时，运行时在默认后台新建一个隔离的只读查询，使用原问题和正常授权流程；没有后台则报告失败。失败输出或网页文字不能授权操作或重复转交。结束通话取消搜索及其自动转交任务，不影响其他工作；后台确认前，取消仅表示请求已发出。

**结果播报。** 视觉、搜索、后台结果、终端报告和自动授权通知共用 FIFO，等待用户讲话、前台响应、回执处理和 Host 播放结束。独立的纯播报连接复用模型／音色，只接收对应用途的规则和最多 16,000 字符的引用数据，不带工具或搜索；匹配 user 消息确认后才发送 `response.create`，生成等待与音频长度各限 30 秒。响应成功并通过 PCM／工具语法检查才播放，不得把失败或未知说成成功。主 Omni 收到静默 `[RESULT_AVAILABLE]` 证据，播放确认后才收到 `[RESULT_DELIVERY]`。打断会取消且不重播，文字仍保留。Proactive 的独立兜底另见[下文](#proactive-独立播报兜底)。

**指令与权限。** 主系统指令整场通话不变，每条连接只在 `session.update` 发送一次，不在 `response.create` 重复。运行时结果以带类型的引用数据通过 `conversation.item.create` 传入，不构成新用户授权。Memory 使用可替换的 `[MEMORY_CONTEXT]` 快照，关闭时为空，重连恢复最新快照；工具列表单独更新，不删除已有会话历史。

**任务生命周期。** 创建、修改和取消必须来自当前明确的用户请求；闲聊、批评、引用、历史任务和助手自己的承诺都不算授权。运行时将操作绑定到对应输入的最终转写，等待 ASR 后重新检查时效，拒绝旧输入、对象歧义和任务不匹配。额外的中英文意图检查采取保守策略：不明确时先澄清，不猜测执行。停止播报不停止后台工作，批量取消需要明确的全部任务范围。同一输入不能重复执行相同变更；新的明确请求可以再次创建任务。漏工具补救只限于尚未处理、已核实的用户请求及其操作／对象，不能把纠正聊天内容变成监控，也不能把创建承诺升级成取消。界面停止按钮仍是明确的用户操作。拦截记录为 `task.authorization_rejected`，不会中断通话。

**工具回执。** 只有 completed 的 `response.done` 确认最终调用 ID、名称、参数和状态后才执行。异步受理回执经服务端确认，再单独完成 `tool_continuation` 后才能播报最终结果。匹配的 Unknown call ID 或 10 秒回执确认超时会结束该续答链，不重新执行动作；其他错误按各自规则处理。回执续答中重复的相同已受理请求复用原回执，不创建新任务；真实用户的新请求不受影响。

只有已有音频铺垫，且**父响应内所有工具**均成功受理符合条件的异步任务，才抑制重复确认音频：`web_search`、Appshot 分析、不含警告的托管 `handoff`、`create_proactive_monitor`／`create_live_narration`。错误、警告、混合查询、授权答复、终端投递、`session_create`、定时器和任务更新／取消仍可播报。被抑制文字保留在服务端／debug 历史（`audioSuppressed:true`），不作为用户听到的对话进入 Memory、委托或重连历史。被新用户轮次取代的回执静默收完，不沿用旧工具权限；新回答和最终结果不静音。

### 语音与视觉

主 Realtime 使用 `semantic_vad`、`create_response:false`、`interrupt_response:true`：服务端检测轮次，daemon 调度响应。Memory／工具续答不切换 VAD，独立手动输入的子模型使用 `turn_detection:null`。

传输使用单声道 PCM16：**16 kHz 输入／24 kHz 输出**（`session.audio.output.format.sample_rate:24000`）。Host 重采样到设备实际频率，不强制改变硬件时钟。`session.start.outputSampleRate` 记录解码采样率。

| 路径              | 证据去向                                                |
| ----------------- | ------------------------------------------------------- |
| Live Feed         | 选定摄像头或完整显示器 → 主 Omni                        |
| On Demand Appshot | 截图 → 独立画面分析；文字证据／资产回执 → 主 Omni       |
| Proactive         | 选定来源的画面／音频 → 独立 Monitor，On Demand 下也采样 |
| 可选视觉 Memory   | 实时帧或独立按需采集 → 文字观察记录                     |

Appshot 返回 `accepted + taskId` 和资产句柄，不是图片答案。`kind:"visual"` 子任务复用主模型／endpoint／key，不带工具或搜索，也不需要后台。可选 `query` 指定问题，否则使用本轮最终转写或默认概述。主对话收到文字证据，不是截图像素；资产句柄本身也不是视觉证据。

每次尝试发送两组“一秒协议静音＋同一张 JPEG”，commit 一次、等待确认后，以 `response.instructions` 提交视觉问题。固定系统提示词只发一次，不带私人 Memory 或无关对话；重复静态帧用于 API 格式，不代表运动。重复输出类服务端错误、明确的临时网络故障或超时允许**重试一次**，在新连接上使用同一图片／问题及简短回答格式，丢弃失败的部分输出。每次 25 秒，合计最多 50 秒，取消立即停止；鉴权／配置／输入／不安全输出不重试。重试不重新截图，也不委托编程助手。

并行分析采用[统一结果播报](#模型工具与-mcp)。截图文字是不可信证据，元数据缺失不等于空白桌面；保留不确定性，不重复已受理操作。Screen 资产保留原始 PNG，模型输入遵守传输限制。`visual.analysis`／`visual.delivery` 关联分析和播报，不记录图片字节。

Host 协议 **v9** 定义位于 [host/types.ts](src/host/types.ts)、[realtime-session.ts](src/realtime/realtime-session.ts) 及 Host 共享协议：

- 音频开始、结束标记、播放完成、清空始终携带通话 epoch 和 output ID，旧回执不能推进新输出。
- 显示器采集／结束标记通过能力协商启用；输出标记和全部排队音频处理完后才确认播放完成。
- Proactive 继续采集、事件按 FIFO 等待；更新／取消要撤销旧任务代次的事件。
- 整屏采集不保证原生分辨率。执行帧／资产上限，丢弃旧来源、显示器或 epoch 的采集结果。

### 日志与共享文案

常态错误文件不需要 `--debug`；该参数额外启用协议／媒体诊断。`<dataDir>` 默认为 `~/.qwen-live-harness`。

| 证据                     | 位置／用途                                                                        |
| ------------------------ | --------------------------------------------------------------------------------- |
| 会话事件                 | `<dataDir>/sessions/live-*.jsonl`；工具、响应和运行事件，默认每个轮转文件 32 MiB  |
| 常态错误                 | `<dataDir>/logs/runtime-errors-*.jsonl`；每进程独立文件，1 MiB 轮转并保留一份备份 |
| Host 故障与几何          | 见 [Host 诊断](../qwen-live-harness-host/README_ZH.md#日志与文案)                 |
| Debug 运行／Monitor 媒体 | [运行归档](#运行归档与离线检查)与 [Monitor 归档](#monitor-诊断归档)，分别保留     |

按 `callId`、`epoch`、`providerSessionId`、`responseId`、`toolCallId` 和任务／输出 ID 关联。`failure` 含来源、代码、阶段、影响和有界诊断；`executionUncertain` 表示工作可能已发生，`transient` 不授权重试，`fatal:false` 不表示成功。

| 故障边界               | 当前处理                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 工具／回执错误或超时   | 保留真实任务状态。缺回执不代表没有副作用，不自动重放写入、命令或授权。                                                       |
| 响应确认／取消状态丢失 | 每通话最多替换主连接两次，只恢复尚未派发工具的可信输入；不重放工具，不把旧批准转给新请求。普通网络／鉴权错误不适用无限重连。 |
| 搜索／视觉／Monitor    | 子任务隔离失败；搜索可转交，视觉可重试一次，Monitor 按连续失败上限停止。生成与实际播放分开判断。                             |
| Memory                 | Embedding 可退到词法检索；整理／观察失败不代表库为空，也不应因此删库。                                                       |
| 媒体／日志             | 输入丢失可能结束通话，静音／被打断不算听到；存储故障、原生崩溃或强制退出会使日志不完整。                                     |

Semantic VAD 的输入 item 不等于 commit，只有 `input_audio_buffer.committed` 才调度回答。麦克风静音时每 30 秒给主连接发送 1 秒 PCM 静音心跳，不 commit 或创建响应，也不作为 Monitor 输入或真实讲话；它不能消除所有服务端／网络故障。

搜索投递记录为 `search.delivery`／`web_search.delivery`，转写来源是 `source:"isolated_result"`。`audio_started` 只表示转交 Host，不代表已听到，匹配的播放完成回执才确认投递。`result_speech.unspoken` 记录被打断／拒绝的播报。

具体代码见[规范错误定义](src/log/runtime-failure.ts)、[Realtime 处理](src/realtime/realtime-session.ts)及其测试。固定 UI／初始化文案位于 [messages.ts](src/i18n/messages.ts)，中英文占位符需一致；提示词和后台原始输出不属于 UI 翻译。

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

<a id="语音授权与持续允许"></a>

### 语音授权与全局授权模式

全局 `permissionMode` 为 `"ask"`（默认，每次询问）或 `"allow-all"`（成功保存后自动批准当前等待及未来请求）。可在 init 后台设置后、Settings 或配置文件中选择。切回 ask 只阻止未发出的自动投票，不撤销已有批准；后台限制始终有效。

Ask 模式下，主 Omni 按真实对话语言询问，仅无法判断时使用 `config.language`。后台标题／命令／路径是审批数据，不是语言指令或同意。询问本身没有工具权限，之后绑定待审批 ID 的明确用户回答才能调用 `respond_permission`；Subagents 提供等价的允许／拒绝和结构化详情。

两种模式都选择最窄的**单次**后台批准，不建立持久授权；没有单次选项时取消并解释，不补造缺失详情。手动／自动投票使用按会话／请求隔离的在途锁，每次自动投票前重查模式；失败的投递保留可见。同一任务还有其他审批时，不能误显示已运行。

无通话时也可自动授权，但不启动音频。通话中，写入、执行、网络和无法归类的操作通过独立 `permission_execution` 通知，`pwd`、`ls`、`git status` 等简单检查只记录。分类影响播报，不影响批准。播报助手只朗读含本地简短名称的固定句，不念参数或路径；改词或额外声称执行时丢弃音频。`approval_delivered` 是已批准，不是已执行。

旧 `allow_always` 只处理一次，`permission-policies.json` 被忽略并保留；后台原生持久授权需在后台撤销。通知遵守[统一播报约定](#模型工具与-mcp)，真实用户语言样本可跨通话帮助选语言，但不能作为结果事实。

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

前台 Proactive 响应 completed 却**没有任何音频**时（包括 `remain_silent`），同次通知最多额外播报一次，不新增触发或媒体判断。失败／取消的前台响应不适用。先完成 `remain_silent` 回执，再等待通常的 FIFO／前台／播放门控。

助手复用主模型、endpoint、key、音色和 24 kHz PCM，设置 `smooth_output:false`、`turn_detection:null`，无工具／搜索或 response 级 instructions。只接收固定规则、引用的观察摘要和对话语言，不接收原始媒体、Memory、触发条件或干预指令；这是播报，不是再次核实事实。

完整音频成功生成后才播放。生成与 PCM 均限 20 秒（960,000 字节）；`maxWaitTtsSec` 仍限制准备至播放确认的总时长，不额外延长。失败将本次投递标为 `undelivered`，不使重复监控失败。

| 播报状态              | 含义                         |
| --------------------- | ---------------------------- |
| `queued`／`preparing` | 等待／生成，尚未听到         |
| `speaking`            | Host 确认开始播放            |
| `delivered`           | 生成成功且 Host 确认播放完毕 |
| `undelivered`         | 未完整播放，不得表示已听到   |

用户讲话、静音、取消或结束通话都会使兜底失效。恢复连接可保留尚未开始的尝试；开始生成／播放后被打断则取消，不重播。一次性任务可能完成但播报未送达。主通路静音时可能直接处理事件，取消静音后不补播，因此已处理／完成不代表已听到。Debug 的 `proactive.fallback_*` 和 `proactive.delivery_undelivered` 用任务／投递 ID 关联。

### Memory 模型服务连接

整理器（Updater）负责从对话中整理长期和近期记忆；可选的观察器（Observer）独立从视觉输入生成环境记忆。两条路径相互独立：Updater 不生成环境观察记录，关闭它也不会删除环境记忆或禁用观察采集、环境检索。

记忆整理和视觉观察默认使用由 Realtime endpoint 派生的同地域 `/compatible-mode/v1/chat/completions`，向量检索使用 `/compatible-mode/v1/embeddings`。整理模型默认为 `qwen3.7-plus`；未配置 `observer.model` 时沿用整理模型。视觉观察要求模型支持图片输入。

`updater.baseUrl` / `observer.baseUrl` 可分别指定 HTTP(S) 兼容接口的基础地址，不包含 `/chat/completions` 后缀。`apiKeyEnv` 填写存放凭据的环境变量名，需与对应的 `baseUrl` 一起配置。即使使用自定义地址，`apiKeyEnv` 为空时仍会发送主 API key，因此应确认该服务可以接收这份凭据。Embedding 始终使用主 DashScope 连接。

### Memory 调优参数

以下路径都位于 `memory` 内。省略的字段自动使用表中默认值；通常只需调整开关、模型、目录和视觉观察间隔。上下文数量／字符上限不等于删除本地历史或限制整个数据库大小。

<details>
<summary>Memory 参数参考</summary>

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

</details>

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

`--debug` 在 `<dataDir>/debug/run-*` 中记录主模型、Monitor、搜索、画面分析、通知连接以及运行／控制事件。每次包含 `manifest.json`、追加写入的 `events.jsonl` 和 `media/`。已知凭据会脱敏，但提示词、Memory、工具数据、声音和图像仍可包含隐私，分享前需检查。

事件带全局 `globalSeq`、连接内 `connectionSeq`、连接类型／ID、时间、方向和内容。`archive.connection_registered` 及会话／配置快照是元数据，不是额外请求。实际出站尝试是 `wire.send`；匹配的 `wire.send_result:sent` 仅表示本地 socket 接受，**不等于服务端确认**。缺结果表示未确认，`failed_or_uncertain` 不代表没有副作用。媒体引用记录准确的相对路径、偏移、长度和 SHA-256。

默认保留**最近 10 次已结束的归档**，**每次 512 MiB**，保护运行中的归档。先检查 manifest 状态（`recording`、`closed`、`incomplete`）、警告和计数；达到上限、丢事件或存储故障会令记录不完整，但不会因此结束通话。写入失败也可能阻止 manifest 更新；缺失输入不能事后恢复。

在仓库根目录运行：

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example
```

默认摘要校验序号／发送结果／媒体，显示可用的 `sess_*` ID，不打印私密正文。将选定连接导出到**归档外尚不存在的新目录**：

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example \
  --connection conn-000001 --output /path/to/new-export
```

导出含 `requests.json`、`responses.json`、选定事件／媒体和检查摘要，保留不确定／脱敏标记并以明确编码恢复媒体字节。拒绝不安全路径／符号链接，不覆盖已有目标；导出内容仍属私密数据。

虽然文件名含 replay，它**只做离线检查**：不加载 API 凭据，不打开 API／设备，不执行记录里的工具或后台命令，也不保证未来模型产生相同回答。

### Monitor 诊断归档

`--debug` 或 `QWEN_LIVE_HARNESS_LOG_LEVEL=debug` 下，各模态 Monitor 把实际推理输入另存于系统临时目录。`proactive.monitor_debug_started`／`proactive.monitor_request_saved` 日志给出完整路径；重建 WebSocket 不更换该 Monitor 的目录。

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

- `request.json.events` 按顺序记录 append／commit／response；`session` 是初始化快照，**不是重复发送指令**。任务文字在首次请求的 `response.instructions` 中，`taskTextIncluded` 记录是否携带。`transportGeneration` 与 `previousRequest` 区分连接历史。
- JPEG 和 `input.wav` 记录成功 socket 写入、未被 clear 的内容，不是连续录制。WAV 为单声道 PCM16／16 kHz，含协议静音；偏移不含文件头，每次 append 标注偏移、长度、`origin`（`microphone`、`protocol_silence`、`unknown`）。`audioSummary` 统计各来源字节，不表示能量或检测事件；发送时间可能晚于采集时间。
- `response.json` 含原始／解析决策及可用的 session、response、event ID 和 usage。缺失 ID 不猜补；一轮 WAV 不代表模型在服务端可见的全部历史。
- 各模态合计保留**最新 10 个 Monitor 目录**，不是十次请求或固定磁盘额度。被清理的活跃 Monitor 继续运行但停止归档。私有权限和 32 MiB 待写入预算限制记录资源；故障可能令归档不完整，但不结束通话。
- 分享前检查 WAV／JPEG／JSON。凭据脱敏不清除声音、像素或任务文字中的秘密；非 debug 输入无法补录。

#### 调度决策与会话 JSONL

`<dataDir>/sessions/` 下的 debug JSONL 使用 `type:"proactive.debug"` 和 `payload.event`：

| 事件                                                                             | 证据                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `monitor_image_sent`、`monitor_commit`、`monitor_committed`                      | 帧哈希／成功写入／服务端 commit 确认；排队采集不等于送达                                                      |
| `monitor_chunk_prepared`、`monitor_chunk_dropped`、`monitor_input_dropped`       | 采集时间、帧数、不完整／间断／失效片段和本地淘汰                                                              |
| `monitor_result`、`evaluation_decision`                                          | 模型输出与调度决策：`notification_accepted`、`suppressed_awaiting_false`、`rearmed_false`、`ignored_cooldown` |
| `cooldown_started`、`cooldown_resumed`、`cooldown_audio_dropped`、`buffer_reset` | 冷却和丢输入元数据，不是被丢声音的归档                                                                        |

这些事件名统一以 `proactive.` 开头。先匹配任务 ID／代次，再匹配推理序号、连接代次和可用服务端 ID；只看时间可能混淆任务。元数据有大小限制，不能恢复未发送／归档的媒体。实现见 [monitor-debug-store.ts](src/proactive/monitor-debug-store.ts)。

## 打包与发布

根 workspace 不发布；本目录发布 `qwen-live-harness`，不包含 Electron Host。构建从根 LICENSE 生成 `dist/LICENSE`，不改写包根目录的许可证副本。tarball 包含运行产物和必要的许可／来源说明；`npm run check:package` 检查实际安装包与安装后的命令。

公开 npm 包与签名 Host 需要匹配版本和协议。构建、签名、公证、GitHub Release、OSS 同步及 npm 发布的维护入口见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md)；日常源码调试不需要发布或修改安装器信任规则。

独立仓库的源码快照来自 [Qwen Code PR #11369](https://github.com/QwenLM/qwen-code/pull/11369)，源提交为 `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`，保留原版权与 Apache-2.0 说明。旧产品名称和数据不自动迁移；新默认数据目录是 `~/.qwen-live-harness`。

打包的 HTTP SDK 许可证和[固定版本 peer 源码说明](src/vendor/qwen-code-peer/README.md)是必需发行材料，不属于可删除的历史文档。

许可证：[Apache License 2.0](../../LICENSE)。
