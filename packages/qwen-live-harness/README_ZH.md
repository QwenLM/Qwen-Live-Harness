# Qwen Live Harness · Daemon 开发指南

简体中文 | [English](README.md)

本目录是 `qwen-live-harness` npm 包：负责模型连接、对话调度、任务委托、Proactive 和 Memory。桌面界面、系统授权与设备采集由独立的 macOS Host 负责。

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

`npm run init` 构建 daemon 后打开源码初始化向导，保存配置；不会下载安装 Host，也不会登记桌面启动运行时。可以选择后台编程代理，也可以先不接入后台 Harness。

选择 Qwen Code 后，向导默认提供由 Live 自动启动本地 Qwen Serve，也可连接已有本地服务或选择 ACP。初始化只保存这些设置，服务在 daemon 启动时才拉起；终端发现与授权的区别见 [Qwen 终端接入](#qwen-终端接入)。

`npm start` 构建两端，启动本仓库的 daemon 和 Electron Host。它不使用全局 CLI 或 `/Applications` 中的 Host。请先退出已有的 Qwen Live Harness；源码启动器拒绝接管正在运行的实例。`Ctrl+C` 会清理本次启动的进程。

需要诊断日志时运行：

```bash
npm start -- --debug
```

源码入口由 [`scripts/start-dev.mjs`](../../scripts/start-dev.mjs) 管理。已安装 npm 包的用户启动流程不同，见[项目首页](../../README_ZH.md#快速开始)。

## 先看哪些代码

| 位置                                                                                           | 职责                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`src/index.ts`](src/index.ts)、[`src/cli-startup.ts`](src/cli-startup.ts)                     | CLI 入口、实例复用、启动和退出                    |
| [`src/config.ts`](src/config.ts)、[`src/init.ts`](src/init.ts)                                 | 配置校验、环境变量优先级、交互初始化              |
| [`src/peer-setup.ts`](src/peer-setup.ts)、[`src/peer-diagnostics.ts`](src/peer-diagnostics.ts) | Qwen 终端增量设置和只读诊断                       |
| [`src/daemon.ts`](src/daemon.ts)                                                               | 装配服务、Host HTTP/WebSocket 入口、资源清理      |
| [`src/host/`](src/host/)                                                                       | Host 协议、发现文件、通话状态和安装器             |
| [`src/orchestrator/`](src/orchestrator/)                                                       | 对话生命周期、工具分发、后台事件与播报队列        |
| [`src/realtime/`](src/realtime/)                                                               | 主 Realtime 协议、system prompt、独立文本搜索连接 |
| [`src/adaptor/`](src/adaptor/)                                                                 | 后台代理适配器、能力声明和事件归一化              |
| [`src/tools/`](src/tools/)                                                                     | 模型工具定义、回执、session/job/asset 句柄        |
| [`src/permissions/`](src/permissions/)                                                         | 后台真实授权请求的转发与答复                      |
| [`src/proactive/`](src/proactive/)                                                             | 监控、计时、事件触发与 FIFO 播报                  |
| [`src/memory/`](src/memory/)                                                                   | 本地记忆库、检索、整理和可选视觉观察              |
| [`src/subagents/`](src/subagents/)                                                             | 子智能体状态、详情和手动停止接口                  |
| [`src/log/`](src/log/)、[`src/logger.ts`](src/logger.ts)                                       | 会话记录与运行诊断                                |
| [`src/i18n/messages.ts`](src/i18n/messages.ts)                                                 | CLI 与 Host 共用的中英文固定展示文案              |

一次通话主要沿着 `LiveDaemon → LiveHostCoordinator → LiveSession → Realtime / BackendAdaptor` 运行。Qwen Serve 是 REST/SSE 后台适配目标，可由 Live 管理启动或连接已有服务；选择 ACP 或无后台模式时不需要它。

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

默认单元与协议测试使用替身和本地测试服务，不依赖真实模型账号。真实后台账号测试是另外的显式验证入口，不要把付费 API、真实设备授权或个人凭据写进普通测试。

## 隔离配置与单独调试 daemon

默认配置是 `~/.qwen-live-harness/config.json`，该目录也承载 Memory 与会话数据。

开发时可以为配置、Memory、会话日志和发现文件使用独立目录。在运行初始化及启动命令的终端中设置：

```bash
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-dev"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
npm run init
npm start -- --debug
```

两个变量分别控制数据目录和发现文件的**基础目录**。只修改 `DATA_DIR` 不会移动发现文件；同时运行多套开发配置时要一起隔离。完整覆盖规则见[环境变量参考](#环境变量参考)。

需要独立运行 daemon 时，先构建，再直接调用产物：

```bash
npm run build
node packages/qwen-live-harness/dist/index.js --daemon-only --debug
```

`npm start` 是两进程开发启动器，不接受 `--daemon-only`。单独启动 Host 时，使用本仓库 Host 的开发入口，并将 `QWEN_LIVE_HARNESS_DISCOVERY_FILE` 设置为对应目录下的完整 `run/daemon.json` 路径；不要把基础目录直接传给它。

进程之间的约定：

- `run/daemon.json` 发布 loopback 地址、协议版本、PID 和实例 nonce；连接使用 Bearer token 与实例 nonce 校验。发现文件是私有状态，不应打印或复制其中的凭据。
- `run/runtime.json` 用于**已安装版本**的桌面启动，保存 Node/CLI 的绝对路径、版本和必要启动信息，不复制 API key。源码 `npm start/init` 不创建或刷新这个登记。
- 正常进程退出写入实例专属的 stop marker，让尚未握手或正在重连的 Host 也能退出。标记不能让旧实例关闭新实例；普通断线不等于用户要求退出。
- End call 结束当前交互及 Proactive 采样，已委托的后台任务可以继续。退出整个应用会清理 daemon 拥有的资源、ACP 子进程和自动启动的 Qwen Serve；不会终止用户独立运行的服务或终端。退出失败的重试仍须绑定原来的认证实例。

相关实现位于 [`startup.ts`](src/startup.ts)、[`startup-lock.ts`](src/startup-lock.ts)、[`host/discovery.ts`](src/host/discovery.ts) 和 [`lifecycle.ts`](src/lifecycle.ts)。

## 接入新的后台 Harness

如果代理已经支持 ACP，通常只需要配置 `kind: "acp"` 的 `command`、`args` 和必要的 `env`。若希望 init 自动发现它，再扩展 [`agent-detector.ts`](src/agent-detector.ts) 及对应测试。

新协议的接入点是 [`BackendAdaptor`](src/adaptor/types.ts)：

1. 在 `src/adaptor/` 实现适配器，提供 `preflight`、会话管理、`prompt`、事件流、取消、授权答复和 `close`。
2. 如需新的配置类型，更新 `BackendConfig`、配置校验，以及 [`daemon.ts`](src/daemon.ts) 的 `buildAdaptor`。不要把某个代理的分支散布进通话调度器。
3. 用真实能力填写 `capabilities()`，为协议行为补测试，再验证任务委托、事件关联、权限和清理。

现有 [`AcpAdaptor`](src/adaptor/acp-adaptor.ts) 与 [`QwenCodeAdaptor`](src/adaptor/qwen-code-adaptor.ts) 可作参考。后者通过 REST/SSE 连接 Qwen Serve，自动启动由 [`ManagedQwenServe`](src/adaptor/managed-qwen-serve.ts) 管理；连接已有服务时不拥有该外部进程。

适配时需要保持的约定：

- `prompt()` 返回的是接收／排队回执，不是最终结果。完成由 `turn_complete` 等事件确认；使用稳定的 `jobRef` 或明确的 joined-turn 标识关联事件，不能猜测任务已完成。
- `steering`、`imageInput`、`permissionForwarding` 等能力必须如实声明。不支持图片时不能宣称已把截图交给后台。当前持续后台状态观察要求 `eventDelivery: "stream"`；声明其他投递方式本身不会自动增加消费实现。
- 授权只来自后台实际发出的请求。普通文件写入失败不能被包装成伪造的授权弹窗，也不能默认替用户同意。未知任务的取消不能退化为停止同一会话里的其他任务。
- `close()` 清理本适配器拥有的进程、订阅和请求。用户已有的独立服务不属于它。

`backends: []` 是明确的无后台模式，不创建占位代理。语音、视觉、Proactive、Memory 仍可使用；后台工具返回 `no_backend`。如果已配置的默认后台不可用，启动仍然失败，不会静默切换到无后台模式。

## Qwen 终端接入

这条路径连接已经运行的 **Qwen Code 交互式终端会话**。它使用 Qwen 的公开 peer 协议，不读取任意终端的 stdout，也不把外部终端变成 Live 拥有的进程。发现、发送文本、接收报告是分别配置的三项能力。

### Qwen Code 的三种连接方式

主初始化向导为 Qwen Code 提供：

| 方式                                | 配置与生命周期                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 自动启动本地 Qwen Serve（默认选项） | `kind: "qwen-code"` 与 `managedServe.command`；启动已安装的 Qwen，使用 loopback、系统分配端口和新认证 token，退出时清理本次服务 |
| 连接已有本地 Qwen Serve             | `kind: "qwen-code"` 与 `baseUrl` / 可选 `token`；不启动或停止该外部服务                                                         |
| ACP                                 | `kind: "acp"`，以 `qwen --acp` 启动；不启用 peer 终端发现                                                                       |

自动启动的配置条目示例：

```json
{
  "name": "qwen",
  "kind": "qwen-code",
  "default": true,
  "managedServe": { "command": "/absolute/path/to/qwen" }
}
```

将此条目放入 `backends`，把 `command` 换成实际可执行文件路径。`managedServe` 不能与 `baseUrl`、`serveUrl` 或 `token` 同时配置；工作目录使用 `defaultCwd`。后台继续沿用 Qwen 自己的模型认证和设置，Live 不替它配置模型或授权终端消息。

向导选择两种 Serve 方式时，还会保存当前 `QWEN_HOME`（缺省为 `~/.qwen`）对应的只读 `peerDiscovery`。它不会自动授予发送文本的权限，也不会开启报告接收。手动配置远程 Serve 时，本地 peer 目录仍然是本地的，不会变成远程终端发现。

<a id="terminal-setup-and-diagnostics-m3-stage-4"></a>

### 增量设置与只读诊断

已有 Live 配置后，从仓库根目录执行：

```bash
npm run build
node packages/qwen-live-harness/dist/index.js init --peers
node packages/qwen-live-harness/dist/index.js doctor --peers
```

已安装 CLI 的对应命令是 `qwen-live-harness init --peers` 和 `qwen-live-harness doctor --peers`。源码启动脚本当前不转发 `--peers`，因此使用上面的构建产物入口。

`init --peers` 只修改选定 `qwen-code` 后端的 `peerDiscovery`；可选已有后端，或增加一个连接已有 Serve 的条目，不会把 ACP 自动转换成 Serve。其他配置与原默认后端保留，取消不写文件。该命令要求已有常规 `config.json`，遇到会遮蔽结果的后台环境变量覆盖会拒绝编辑。保存使用锁和原子替换；不要同时在编辑器中改同一文件。修改完成后重启 Live。

`doctor --peers` 检查配置、终端目录、连接能力及授权设置，不启动通话、不发送指令、不创建授权。对于尚未启动的 `managedServe`，它显示未验证，不会为了检查而拉起服务或猜测动态端口。检查显示“已配置 controller”不等于该授权仍然有效。

### 发现现有终端

发现要求 `kind: "qwen-code"` 后端配置 `peerDiscovery.qwenHome`，并与目标 Qwen 终端使用同一个本地 Qwen home。Qwen 侧需要 `agents.crossSessionMessaging: true`；修改后应重启目标终端。省略 `peerDiscovery` 会关闭发现，ACP 条目不支持这个设置。

启动一次语音通话后，`session_list` 会同时列出托管会话和可达的 `tui` 终端。Host 的 Subagents 面板包含 **Terminal sessions**，可用 Refresh 更新列表。外部终端执行状态保持 `unknown`，没有 controller 授权时标为只读；它们不计入普通任务的 Running / Completed 数量。

目录与 socket 的名称是展示信息，发送目标绑定 Qwen home、会话 ID、PID 和启动时间组成的句柄。同名终端不会仅凭名称被选中；发现失败也不应被解释成该终端任务已完成。

### 向终端发送文本

使用支持 `sessions controllers` 的 Qwen CLI，在**同一个 Qwen home** 手动创建 controller grant：

```bash
QWEN_HOME="$HOME/.qwen" qwen sessions controllers add --label "Qwen Live Harness" --json
```

用增量设置向导保存返回的 token，或设置 `peerDiscovery.controllerTokenEnv` 指向已经包含该 token 的环境变量。`controllerToken` 与 `controllerTokenEnv` 只能二选一；该 token 与 Serve 的 REST token 不同，不应通过语音传递。环境变量方案还需确保启动 Live 的进程能读到它，双击 Host 不会自动继承终端里的变量。

开始通话、列出会话，再要求 Live 给选定终端发送具体指令。`handoff` 会发送文本并返回独立的 `delivery_N` 回执；它不是后台 job，不证明指令已经执行、追加到当前轮次或完成。此通道不接受截图附件，也不能停止终端任务或代答其工具授权。

目标终端的 `agents.crossSessionInbound` 策略仍然有效：`hold` 要求在终端审阅，`refuse` 拒收。Host 的 **Instruction deliveries** 展示投递状态，`session_monitor` 可用 `delivery` 参数查询：

- `pending`：尝试写入，尚无回执；`held`：等待终端审阅。
- `delivered`：进入终端收件箱，不代表任务完成；之后仍可能变为 `expired` 或 `misaddressed`。
- `denied` / `refused` / `dropped` 等按实际回执展示；`unknown` 只表示结果不确定，不能自动重发。

未收到回执时默认 30 秒后显示未知；每个 controller 最多保留 100 条投递记录，满额时先淘汰已结束跟踪的条目，全部仍在跟踪时拒绝新发送。End call 停止跟踪，但不会撤回已经写出的指令。授权管理、撤销和终端审阅仍由 Qwen 自己负责。

发送前会复核注册记录并固定目标 socket 与完整 sessionId，但协议没有原子的 PID／启动时间校验。不能把本地目录元数据视为对同一用户下其他程序的身份认证。

### 接收报告并播报

`peerDiscovery.reports: true` 单独开启报告接收，默认是 `false`；接收报告本身不需要 controller grant，也不会因此让终端可控。每次通话发布一个临时 Live peer 地址；handoff 在适用时附上该地址和报告示例。

目标会话必须提供公开 `send_message` 工具、共享对应 Qwen home，并允许该工具调用。Live 不替用户授予这个权限。托管会话也可以使用该公开工具；没有专属报告 endpoint 的适配器，仅在恰好一个可用报告提供方存在时得到报告指引。

报告可区分 `progress`、`blocked`、`result`、`info`；普通文字按 `info` 接收。Host 的 **Session reports** 独立展示来源、正文及排队／已提交／播报状态，用户也可通过 `session_monitor` 的 `reports: true` 查询。来源无法唯一匹配时显示未确认；来源匹配仅用于归因，不等于对同一用户下任意程序的强身份认证。

播报等待用户讲话、前台回复和设备播放结束后，用无工具权限的独立响应转述。报告不是新的用户指令、授权答复或可验证的任务完成事件；关联的托管任务结果仍由原后台事件负责播报，避免双重宣布。静音时保留文字而不播报；中断或失败的报告不会自动重放。

每份报告最多 2,000 字符，每分钟最多接收 20 份、每来源 socket 6 份；归因等待与播报队列各最多 32 份，显示历史最多 100 份。通话结束后地址与关联失效，不重放旧消息；上一通话的报告保留到下一次通话开始。

实现入口为 [`qwen-peer-discovery.ts`](src/adaptor/qwen-peer-discovery.ts)、[`qwen-peer-controller.ts`](src/adaptor/qwen-peer-controller.ts)、[`qwen-peer-reports.ts`](src/adaptor/qwen-peer-reports.ts) 和 [`session-reports.ts`](src/orchestrator/session-reports.ts)。peer SDK 采用固定版本的[官方 Node-only 源码](src/vendor/qwen-code-peer/README.md)并校验来源；peer 传输支持 macOS/Linux，完整桌面体验仍要求 macOS。当前终端协议测试基线为 Qwen Code 0.23.3，不代表任意旧版本具备这些能力。完整条件、协议限制与验收步骤见 [M3 验收清单](../../docs/m3-acceptance.md)。

## 协议与能力边界

### 模型工具与 MCP

主 Omni 通过 daemon 定义的工具调用 Appshot、Memory、Proactive 和任务委托，并不直接获得后台代理的全部工具。

本包没有独立的 MCP 服务配置或管理层。MCP 应在后台 Harness 中配置，能否在 ACP 会话中使用由后台实现决定；当前 ACP 创建／加载会话传入的是 `mcpServers: []`。新增 MCP 接入不能仅修改 Realtime 工具说明，还需要明确实际执行与授权通道。

主助手在有后台和无后台两种模式下都以 **Qwen Omni** 为身份。普通自足对话直接回答；简单的公开信息查询优先 `web_search`，文件／命令／复杂执行以及用户明确指定代理的工作仍走 Harness。

`web_search` 有无后台都开放，不设置本地模型名称白名单。独立、纯文本的 Realtime 搜索连接原样复用主会话的 model（包括邀测别名）、endpoint 和 API key，不替换模型或使用另一套搜索配置；服务端是否支持原生搜索，以实际响应为准。实现见 [`src/realtime/web-search.ts`](src/realtime/web-search.ts)。

工具立即返回 `accepted + taskId`，搜索任务独立执行，多个查询可并行；每个搜索仍有独立的 25 秒超时。只发送本次查询，不附带语音、截图、Memory 或其他工作会话的上下文。是否实际联网按服务端 usage 判断，未知状态不能说成已核实。

完成结果进入 Injector 的 `search_result` 通道，等待用户语音、前台响应和设备播放结束，由主 Omni 根据 query／answer／searchStatus 组织回答，而不是逐字朗读原始结果。每个结果作为带引用数据的 `[NOTIFICATION]` user 上下文消息发送，不代表真实用户的新请求；其响应没有工具权限，网页内容不能授权再次搜索、委托任务或修改 Memory。搜索显示为 `kind: "search"` 的真实子任务，可单独取消，等待播报与已完成分开表示。

主会话的系统指令在整场通话中保持固定，每条 transport 仅在 `session.update` 中发送一次；`response.create` 不重复或覆盖系统指令。子 agent 结果通过 `conversation.item.create` 发送带类型标记的引用数据。Memory 更新使用可替换的 `[MEMORY_CONTEXT]` user 快照，关闭时发送不含旧数据的禁用快照，不改写系统 Prompt。重连只恢复最新快照；工具列表变化单独通过仅含 tools 的 `session.update` 更新。这不会物理删除已进入服务端当前会话的旧消息。

工具必须等 `response.done` 确认 completed，并核对最终 ID、名称、参数与完成状态后才执行；结果得到服务端确认后才续答。能关联到待确认回执的 `Unknown function call id` 或 10 秒结果确认超时，会停止该续答链并记录静默诊断，不重复执行动作，也不直接关闭通话。其他无法关联的协议／配置错误仍按各自失败逻辑处理。回执被拒绝不代表任务未执行，也不构成再次执行的授权。

异步任务的受理回执必须单独完成一轮 `tool_continuation`：搜索、Appshot 画面分析、受管理的 handoff 或 Proactive 创建回执得到服务端确认后，daemon 先消费这轮响应，再注入最终的视觉、搜索、后台或 Monitor 通知。服务端分别消费受理回执响应与最终结果通知；这轮续答不重复执行任务，也不改写系统指令。

只有当前工具链已经产生音频铺垫，且**父响应里的所有工具**都成功受理了符合条件的异步任务时，才抑制重复确认的音频：范围为 `web_search`、已受理的 Appshot 画面分析、不含警告的受管理 `handoff`，以及已实际提交创建的 `create_proactive_monitor`／`create_live_narration`。模型仍完成回执响应，文字保留在服务端历史和带 `audioSuppressed:true` 的诊断转录中，但不作为用户听到的对话写入 Memory、后续委托上下文或重连历史。没有音频铺垫、出现错误或警告、混有查询工具时，确认照常播报；终端指令投递、权限答复、`session_create`、定时器及任务更新／取消不适用这项抑制。已被新用户轮次取代的迟到回执单独静默消费，不继承旧轮次的工具权限，也不会因此静音真实用户的新回答或最终任务结果通知。

如果确认续答再次调用完全相同的已受理请求，运行时复用原受理回执，不会启动第二个任务。该保护只作用于对应确认续答；不同的链式请求和用户新一轮明确请求仍可执行。复用回执也不会隐藏其中的警告。

原生搜索请求失败（包括服务端拒绝）后，如果已配置后台，运行时只用原查询在默认后台新建隔离会话，添加只读公开信息查询约束，复用现有 handoff、任务记录与权限流程；不把失败输出或网页指令当成授权，也不让主模型重复转交。未配置后台时明确报告查询失败。原搜索记录失败及转交情况，新后台任务按真实事件更新。结束通话或新建对话会取消未完成搜索、撤回待播结果，并停止该通话自动转交的查询；其他后台任务保持原生命周期。停止请求与后台停止确认仍然是两回事。

### 语音与视觉

主语音会话请求 `semantic_vad`、`create_response: false`、`interrupt_response: true`：服务端识别轮次，daemon 调度 `response.create`。Memory 更新和工具续答不应切换主会话的 VAD 模式。独立 Monitor 按窗口手动提交输入，独立搜索只有文本，两者的 `turn_detection: null` 不代表主语音关闭了 VAD。

音频传输使用单声道 PCM16，麦克风输入为 16 kHz，**模型输出为 24 kHz**（`session.audio.output.format.sample_rate: 24000`）。Host 将输出重采样到设备的实际采样率；不要为了适配模型而强制切换系统输出设备的时钟。更新后需重启两端，可通过 `session.start.outputSampleRate` 检查本次通话的播放输入采样率。

视觉输入只有一个选定来源和一种采集模式：

| 路径               | 送入内容与范围                                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| Live Feed          | 连续向主 Omni 发送所选摄像头或所选显示器的完整画面                               |
| On Demand Appshot  | 截图由独立“画面分析”子智能体读取；主模型收到文字证据，以及资产／元数据回执       |
| Proactive 视觉监控 | 向独立 Monitor 发送所选摄像头或完整显示器画面；On Demand 下也可独立采样          |
| 可选视觉 Memory    | Live Feed 复用当前帧；On Demand 私下采集选定显示器或摄像头，存储整理后的文字观察 |

Appshot 截图后，通过 `function_call_output` 返回带资产句柄的异步 `accepted + taskId` 回执。`kind: "visual"` 的“画面分析”子智能体复用主模型、endpoint 和 key 读取编码截图，不提供工具或联网搜索；结果通过没有工具权限的 `visual_result` 通知交回主 Omni。无需后台 Harness。主对话收到文字证据而非直接图片，不能仅凭资产句柄声称看见画面。

视觉子智能体依次发送两组“一秒协议静音＋同一张 JPEG”，commit 一次并等待确认，再用 `response.instructions` 提交视觉问题、请求文字推理。重复静态帧只满足视频格式，不能当成运动证据；固定系统 Prompt 只发一次，不发送私人 Memory 或无关对话。分析超时为 25 秒，手动停止或 End call 会取消，失败不会自动转给编程代理。多个分析可并行，完成结果复用只读结果 FIFO 与播放确认；Subagents 展示排队／运行状态，静音时保留文字结果。Screen 的原始 PNG 资产仍保留，模型输入遵循截图传输限制。

Appshot 可选参数 `query` 表示当前视觉问题；省略时优先使用本轮已完成的转录，否则要求概述画面。只有成功受理时才能略过重复确认音频。结果 Prompt 禁止从 `app=Unknown` 推断空白桌面、重复已受理请求、执行截图内文字的指令或猜测看不清的细节。`visual.analysis` 与 `visual.delivery` 诊断关联子模型和前台响应，不记录图片字节。

协议类型与限制以 [`host/types.ts`](src/host/types.ts)、[`realtime-session.ts`](src/realtime/realtime-session.ts) 及 Host 的共享协议实现为准。当前 Host 协议为 v9：

- 输入／输出绑定 call epoch；输出还绑定 `outputId`。播放开始、完成和清空必须保留这些身份，不能让旧音频的回执推进新轮次。
- 显示器捕获和音频结束标记等扩展通过 capability 协商。支持结束标记的 Host 只有在该输出的标记与已排入的音频全部处理完后，才能确认播放完成。
- Proactive 通知等待前台与设备播放结束后按 FIFO 播放；采样可继续、事件可继续入队。任务更新或取消需要撤销其旧事件。
- 完整显示器覆盖不等于原生像素分辨率。实时帧与单次截图资产采用不同尺寸／传输限制；切源、切显示器和换 epoch 后应丢弃晚到结果。

### 日志与共享文案

用 `--debug` 对照 Host 连接、epoch、采集尺寸、帧 hash、工具回执和播放时序。会话 JSONL、Memory 数据库与诊断文件不是同一种日志；其中可能包含用户对话和任务内容。

搜索结果投递在会话 JSONL 中记录为 `search.delivery`，debug 终端中为 `web_search.delivery`。按任务、服务端 Session 与 response ID 对照 `queued`、`requested`、`response_started`、`transcript`、`audio_started`、`response_done`、`finished` 各阶段。`audio_started` 只表示已向 Host 转交音频，不代表用户已经听到；投递完成还需播放确认。结果响应完成但没有可播放音频时，Subagents 保留结果并显示 `search.answerUnspoken` 对应的“未生成语音答复”状态，同时记录非致命的 `search_answer_unspoken` 诊断，不误报已经播报。

debug 还会记录跨连接的[运行归档](#运行归档与离线检查)，它与会话 JSONL、逐 Monitor 归档分开。音频、视觉及音视频 Monitor 归档保存实际请求和原始图片／音频，只保留最近十个 Monitor 目录；这项独立的保留规则不是固定磁盘配额。结构与诊断方法见 [Monitor 诊断归档](#monitor-诊断归档)，分享前应检查敏感内容。

所有固定 UI／init 文案集中在 [`src/i18n/messages.ts`](src/i18n/messages.ts)，维护成对的 `en` / `zh-CN` 字段及一致的占位符。Host 构建复用该模块；system prompt 和原始后台输出不是 UI 翻译表的一部分。

## 高级配置参考

面向修改适配器、调度策略或记忆实现的开发者。普通用户的编辑步骤和常用示例放在[配置与功能指南](../../docs/configuration_ZH.md)；本节集中说明运行环境覆盖与内部调优参数。参数以 [`config.ts`](src/config.ts) 和 [`memory/config.ts`](src/memory/config.ts) 的校验为准，不需要把所有默认值写入用户配置。

### 后台启动与兼容配置

init 的后台检测规则位于 [`agent-detector.ts`](src/agent-detector.ts)，当前启动入口如下：

| 后台        | 入口                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| Qwen Code   | init 默认可自动启动本地 Qwen Serve；也可连接已有服务或选择 `qwen --acp`           |
| Qoder CLI   | `qodercli --acp`                                                                  |
| Gemini CLI  | `gemini --experimental-acp`                                                       |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp`                                    |
| Codex       | `npx -y @agentclientprotocol/codex-acp`；init 通过 `CODEX_PATH` 指向检测到的程序  |
| Qwen Serve  | REST/SSE 适配器，`kind: "qwen-code"`；`managedServe` 自动启动，或指定已有服务地址 |

ACP 后端的 `command`、字符串数组 `args`、字符串值对象 `env` 与可选 `cwd` 分开配置，不使用 shell 拼接执行。桌面启动优先使用 init 生成的绝对路径；采用 `npx` 的适配器首次运行可能安装依赖。

后端 `name` 匹配字母／数字开头的 1–32 位字母、数字、下划线或连字符；唯一性检查忽略大小写，但引用后端时应使用配置中的原始名称。多个后端必须且只能指定一个 `default: true`；默认后端预检失败会阻止启动，次要后端失败则标为不可用。

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

未配置或找不到指定 ID 时，Live 尝试选择后端公开的 asking 模式：当前实现优先查找 `default`，其次是名称为 `Ask for approval` 的 `read-only`。指定 ID 不存在时会警告；没有匹配的 asking 模式，或 `setSessionMode` 调用失败时，后端仍保留自身的模式，**不能保证已强制进入逐项手动审批**。

模式的实际权限由对应后端决定，应检查其文档及最终状态。当前成功选择任何显式 `sessionMode` 的日志都会写成“不逐项审批”，不能据此推断真实权限；配置 `default` 等模式也不自动意味着免审批。修改这个领域时，应覆盖有效／无效 ID、未提供模式、切换失败和权限请求转发的测试。

### 语音授权与持续允许

权限询问由主 Omni 根据当前真实对话语言生成；没有可判断的对话语言时才回退 `config.language`。后台返回的英文标题、命令或路径是待审批数据，不决定播报语言，也不是用户授权。独立权限询问响应不能调用工具或用进度播报替代询问；用户随后明确答复，再由正常对话调用 `respond_permission`。原始动作在子任务详情中保留。

任务完成／失败通知使用独立 `task_result` 响应。运行时提供真实状态、任务和摘要，模型按当前对话语言简短概括，不朗读内部 ID、原始路径或 Markdown，也不能借通知调用工具。最近的真实用户语言样本可以跨通话保留，但只用于选择语言，不能当作该任务的结果事实。通知消息携带可信语言元数据，不修改系统指令；如果之后有新的真实用户发言，合并回复遵循该发言的语言。

后台提出真实权限请求后，普通 `allow` 只批准当前请求。只有用户明确表示“以后都允许”等持续授权意图，才使用 `allow_always`；这适用于支持权限转发的 ACP 和 Qwen Serve 后端。

`allow_always` 优先选择后端提供的持久授权，由后端保存实际权限范围，例如“允许全部文件编辑”或“在当前项目中始终允许此命令”。有多个持久选项时采用后端提供的首个选项；Qwen 的项目级选项先于用户级选项，不能把它理解为无条件允许所有操作。

如果后端未提供、或为当前请求隐藏了持久选项，就退回单次允许，而不是拒绝；仅在这种情况下，Live 还会为当前会话保留 **30 分钟、只匹配相同动作**的本地允许规则。它不涵盖只是相似的其他操作。

后续明确的 `deny` 会撤销匹配的 Live 本地规则，但不会撤回后端已经保存的持久授权；后者必须在对应后端中清除，也不受 Live 的 30 分钟规则约束。

### Proactive 调优参数

调度器将新媒体按**固定 1 FPS、每段 2 秒**的节奏提供给独立 Monitor。观察、模型推理和前台播报是不同阶段；更频繁地检查调度不会让不完整片段提前就绪，也不能消除网络、推理和播放延迟。

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
| `scheduler.repeat.clearBufferOnResume` | `true`     | 恢复观察时清理旧感知缓冲                                                    |
| `vision.windowSizeSec`                 | `10`       | 本地新画面的暂存时长上限，秒；不是每轮重发的历史窗口                        |
| `vision.minEvalDurationSec`            | `0`        | 首次推理前的额外视觉观察时长；`0` 仍需完整片段和至少两张有效新帧            |
| `audio.windowSizeSec`                  | `60`       | 本地新音频的暂存时长上限，秒                                                |
| `audio.minEvalDurationSec`             | `0`        | 首次推理前的音频观察时长                                                    |

两个缓冲窗口均不能小于 2 秒，最短观察时长不能超过各自窗口。Monitor 帧率和片段时长是固定协议常量，不是可配置字段；前台 Live Feed 使用独立的 `visualInput.fps` 设置。较长采集间断会重新计算连续观察时长，不完整片段会被跳过，已经判断过的画面不能当成新证据。

所有模态的 Monitor 都使用交错的流式缓冲区会话。每条连接只在初始 `session.update` 中设置固定的系统 instructions、`turn_detection: null`、`smooth_output: false` 和空工具列表。每轮 append 新音频，视觉监控同时 append 新图像，然后发送 `input_audio_buffer.commit`，收到 `input_audio_buffer.committed` 后才请求推理。等到 `response.done` 后再提交下一片段。服务端保留先前 user 媒体与 assistant 回复，客户端不重复拼接或发送这些历史。

只有 Monitor 连接的首个媒体请求附带任务文字，写法为 `{"type":"response.create","response":{"instructions":"TASK_TEXT"}}`。这里的 `response.instructions` 是首轮 user 媒体对应的任务文字，不是 Monitor 的系统 Prompt。后续片段使用不含该字段的裸 `response.create`，不会单独发送只有任务文字的 `conversation.item.create`。重建连接时，任务文字随首个新媒体片段再次发送，不重放旧媒体。独立的 On Demand 画面分析也用该字段提交一次图片问题。这两条都是手动媒体推理通路；前台对话、工具续答、后台结果通知和 Web Search 仍不携带 response 级 instructions。

每个纯音频片段包含 2 秒 PCM16／16 kHz／单声道音频，不额外补静音。纯视频片段依次 append 1 秒 `protocol_silence` 静音、一张新图、第二秒静音、第二张新图，然后只 commit 一次，不包含麦克风声音。音视频片段按相同顺序提交两段真实的 1 秒麦克风音频及其对应画面；每个视觉轮次因此包含同一两秒时段内的两张新图。图像不足时不复制此前画面，不完整片段会记录丢弃原因。

慢响应时新媒体留在有界本地队列中，不继续写入正在推理的服务端缓冲，也不把积压多秒音频合并成一轮。重建连接会丢失该 transport 的模型历史；只保留尚未消费的新媒体，不重放已经判断过的旧咳嗽／旧画面。调试时用 `transportGeneration` 区分这些历史边界。

`monitor.representationCompact` 映射到 `session.video.input.representation_compact`，在 Monitor 初始 `session.update` 中、第一段音频（含协议静音）发送前设置。连接内不动态修改，回收或失败重建连接时保留同一配置。调整配置后重启服务；`none` 适合需要保留细粒度视觉信息的监控。

Monitor 不设可配置的任务数量上限；实际并发能力仍受设备资源、采样、模型延迟及播报队列影响。

#### Proactive 独立播报兜底

前台 Proactive 响应以 `status: completed` 正常结束却未产生音频时，包括返回 `remain_silent` 的情况，同一次通知最多使用 **一次**独立播报兜底。它不创建新 Monitor、不增加触发次数，也不重新判断证据。失败或被取消的前台响应不满足这项兜底条件。

如果有 `remain_silent` 调用，必须先回传结果并等确认，完成静默的回执续答，兜底才可通过 Injector 的 FIFO、前台响应与播放门控。它复用主会话的 endpoint、模型、key 和音色，输出 24 kHz PCM，设置 `smooth_output:false`、无工具／搜索、`turn_detection:null`。只发送简短固定规则、引用的观察摘要与当前对话语言，不复制原始媒体、Memory、要求监测的触发条件或干预指令。这是播报通路，不是再次核实观察事实；其 `response.create` 不携带 instructions。

兜底先缓冲完整且成功的生成结果，再交给 Host 播放。请求最多等待 20 秒，PCM 上限为 20 秒单声道音频（960,000 字节）。`maxWaitTtsSec` 限制该次尝试的准备与播放总时长，不因兜底延长；用户设置更短时间时可能先到期。兜底失败或超时只把这次播报记为 `undelivered`，不把重复监控变成失败。

独立兜底的播报状态与任务状态分开：

| 播报状态      | 含义                                             |
| ------------- | ------------------------------------------------ |
| `queued`      | 按顺序等待，包括等待尚未完成的回执续答或连接恢复 |
| `preparing`   | 正在准备响应；已生成／缓冲音频不代表开始播放     |
| `speaking`    | Host 已实际确认开始播放                          |
| `delivered`   | 生成成功，并已收到 Host 播放完成确认             |
| `undelivered` | 本次通知未完整送达，不能表示用户已经听到         |

一次性任务可能显示 `completed`，同时播报为 `undelivered`：表示检测任务结束，不表示通知已播完。重复监控在一次兜底播报失败后仍继续。用户说话、关闭播报、取消任务或结束通话会使排队中的兜底失效。连接恢复时，尚未开始的兜底可继续排在回执流程之后；一旦开始生成或播放，打断、静音、取消、停止或连接恢复都会中止它，不重新播放旧通知。

主通路用 Preparing／Speaking 区分生成和真实播放。关闭播报时，主通路事件可能直接被消费，重新打开后不会补播。此时的已消费／已完成状态**不代表用户听到了声音**；上表严格的 `delivered` 保证针对独立兜底。debug 事件 `proactive.fallback_queued`、`proactive.fallback_started`、`proactive.fallback_audio_ready`、`proactive.fallback_delivered`、`proactive.fallback_undelivered` 与 `proactive.delivery_undelivered` 通过同一 task／delivery ID 关联，不增加触发次数。

### Memory 模型服务连接

Updater 只整理对话中的长期和近期记忆，不生成环境观察记录。环境记忆由单独的可选 Observer 从视觉输入生成；关闭 Updater 不等于删除环境记忆，移除 Updater 的环境输出也不影响 Observer 或环境检索。

整理和视觉观察默认使用由 Realtime endpoint 派生的同地域 `/compatible-mode/v1/chat/completions`；向量检索使用 `/compatible-mode/v1/embeddings`。整理模型默认为 `qwen3.7-plus`，`observer.model` 未配置时跟随整理模型。开启视觉观察需要相应模型支持图片。

`updater.baseUrl` / `observer.baseUrl` 可以覆盖各自的 HTTP(S) 兼容接口基础地址，不能附带 `/chat/completions` 后缀。`apiKeyEnv` 是凭据环境变量的名字，并且必须与对应的 `baseUrl` 一起配置。基础地址已覆盖、但 `apiKeyEnv` 为空时，仍会复用主 API key，应明确核对目标服务和凭据的信任范围。Embedding 始终使用主 DashScope 连接。

### Memory 调优参数

以下路径都位于 `memory` 内。省略的字段自动使用表中默认值；通常只需调整开关、模型、目录和视觉观察间隔。上下文数量／字符上限不等于删除本地历史或限制整个数据库大小。

| 字段                                      | 默认值               | 用途                           |
| ----------------------------------------- | -------------------- | ------------------------------ |
| `enabled`                                 | `true`               | Memory 总开关                  |
| `dir`                                     | `""`                 | 空值使用 `<数据目录>/memories` |
| `defaultId`                               | `"default"`          | 选中的记忆库 ID                |
| `updater.enabled`                         | `true`               | 通话结束后的长期／近期记忆整理 |
| `updater.model`                           | `"qwen3.7-plus"`     | 整理模型                       |
| `updater.baseUrl` / `updater.apiKeyEnv`   | `""` / `""`          | 可选连接覆盖                   |
| `updater.timeoutMs`                       | `120000`             | 单次整理请求超时，毫秒         |
| `updater.temperature`                     | `0`                  | 整理生成温度                   |
| `updater.maxTokens`                       | `2048`               | 整理输出 token 上限            |
| `updater.maxWmEntries`                    | `64`                 | 单次整理处理的工作记忆条目上限 |
| `updater.shutdownWaitSec`                 | `2`                  | 退出时等待整理完成的时长，秒   |
| `observer.enabled`                        | `false`              | 视觉记忆开关                   |
| `observer.model`                          | 跟随 `updater.model` | 支持图片输入的观察模型         |
| `observer.baseUrl` / `observer.apiKeyEnv` | `""` / `""`          | 可选观察连接覆盖               |
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
| `retrieve.maxChars`                       | `5000`                | 原始结果正文预算                                             |
| `retrieve.retrievedMaxChars`              | `6000`                | 渲染到模型上下文后的检索区预算                               |
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
| `retrieve.rrfK`                           | `60`                  | 多路排序融合参数                                             |
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

`retrieve.maxChars` 不能大于 `retrievedMaxChars`；`backfillTimeoutMs` 不能小于 `timeoutMs`；`segment.minTurnsBeforeGapCut` 不能大于 `maxTurns`。高级参数的完整取值范围以 [Memory 配置校验](src/memory/config.ts)为准。

### 环境变量参考

总体优先级为：**环境变量 → `config.json` → 内置默认值**。API key 的优先级更具体为 `DASHSCOPE_API_KEY` → `QWEN_LIVE_HARNESS_REALTIME_API_KEY` → `realtimeApiKey`。更改文件却未生效时，请先检查 shell 中是否已有覆盖。

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

安装版的桌面启动登记保存 Node／CLI 的绝对路径、PATH、配置／发现目录和工作目录，不复制任意 shell 环境变量。需通过双击 Host 使用的参数，建议写入配置文件；仅存在于某个终端的环境变量，不保证从启动器打开应用时仍存在。

`DATA_DIR` 改变配置与默认数据位置，**不会**自动改变 discovery 基础目录；默认仍为 `~/.qwen-live-harness`。例如，已安装 CLI 可使用独立配置：

```sh
export QWEN_LIVE_HARNESS_DATA_DIR="$HOME/.qwen-live-harness-work"
export QWEN_LIVE_HARNESS_DISCOVERY_DIR="$QWEN_LIVE_HARNESS_DATA_DIR"
qwen-live-harness init
qwen-live-harness
```

源码开发将这两条 CLI 命令换成 `npm run init` 和 `npm start`。`DATA_DIR` 只能通过环境变量指定，没有对应的 `dataDir` 配置字段；`discoveryDir` 可以写入配置，并被 `QWEN_LIVE_HARNESS_DISCOVERY_DIR` 覆盖。手动配置独立 Host 连接时，将 `QWEN_LIVE_HARNESS_DISCOVERY_FILE` 设为对应完整发现文件路径。

### 运行归档与离线检查

debug 运行会写入 `<dataDir>/debug/run-*`，与下文系统临时目录里的逐 Monitor 归档独立。运行归档记录实际观察到的主模型、Monitor、搜索、画面分析、通知播报连接，以及运行／控制事件。已知凭据字段、配置中的密钥和可识别的凭据文本模式会脱敏，但不会通过 OCR 或语音识别查找媒体中的秘密；Prompt、Memory 上下文、工具参数／结果、转录及媒体仍是私密内容，不能当作可直接分享的匿名遥测。

每次归档包含 `manifest.json`、追加写入的 `events.jsonl` 和 `media/`。事件保留全局 `globalSeq`、连接内 `connectionSeq`、连接类型／ID、墙上时间、单调时间、方向与记录的内容。`archive.connection_registered` 是连接元数据，不是又发送了一次模型请求；真正的出站请求看 `wire.send`。对应的 `wire.send_result` 为 `sent` 或 `failed_or_uncertain`，其中 `sent` 仅表示本地 socket 接受了写入，不等于服务端确认收到；缺少结果时为 `unconfirmed`。服务端确认是另外的入站事件。

媒体引用记录相对路径、字节偏移、长度、SHA-256、类型与编码，指向准确的归档字节范围，不是事后近似重建的录音。会话／配置快照仅提供上下文，不应误认为每轮都重发了 instructions；判断客户端尝试发送了什么，应查看实际 wire 序列，并结合归档是否完整。

默认**每次归档预算为 512 MiB**，保留**最近 10 次已结束的运行归档**，包括已结束但不完整的归档；活跃归档受保护，总数可能暂时超过十个。`manifest.json` 记录 `recording`、`closed` 或 `incomplete`、警告及计数。达到上限、记录丢失或存储故障只令证据不完整，不应终止通话。写入失败也可能导致 manifest 无法更新，因此还要检查运行警告与缺失文件，不能只看状态字段；未开启 debug 的输入无法追补。

在仓库根目录离线检查一次归档，默认输出不包含 Prompt 或转录正文：

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example
```

从摘要中选择连接 ID，导出到**归档外尚不存在的新目录**：

```sh
node scripts/replay-live-debug.mjs /path/to/debug/run-example \
  --connection conn-000001 --output /path/to/new-export
```

工具校验事件序号、发送结果、媒体范围及哈希，并拒绝不安全路径或符号链接。摘要列出观察到的连接状态、可用且通过格式校验的服务端 `sess_*` ID，以及去重后的响应数量，不输出消息正文。导出包含 `requests.json`、`responses.json`、选中连接的 `events.jsonl`、复制的媒体片段及检查／manifest 摘要；请求／响应 JSON 中恢复 base64 媒体，原始字节数组使用明确的 `$binary` 包装，脱敏标记也会保留。失败或未确认的发送会保留标记，不完整的归档不会标成完整，也不会覆盖已有输出目录。导出内容仍含隐私，分享前必须检查。

虽然文件名含 replay，这个工具**只做离线检查与导出**：不会读取 API key、联网调用、启动设备、执行记录中的函数调用或后台命令。主会话的工具历史仅作为数据导出，供分析使用，不自动重放。任何归档都不能保证未来的模型输出、服务端状态或采样随机性完全相同。

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
- 所有模态的 `request.json.events` 都统一保存逐条音频／图像 append、`input_audio_buffer.commit` 和 `response.create` 事件。每条音频 append 指向 `input.wav`，记录字节偏移、长度和 `origin`。`origin` 中，`microphone` 为麦克风来源、`protocol_silence` 为纯视频片段的静音音轨承载、`unknown` 为未标注来源。`audioSummary` 提供 `totalBytes`、`microphoneBytes`、`protocolSilenceBytes`、`unknownBytes`。这些只是归档诊断字段，不会发送给模型；来源不是能量或事件判断，握手／慢推理时本地缓存的新媒体也可能较晚送出，不能把发送时间当作采集时间。
- `request.json` 保存初始化配置、事件顺序、帧哈希、音频偏移和 `previousRequest`。任务文字位于首轮 `response.create` 事件的 `response.instructions` 中，后续请求不包含该字段，也没有单独的任务 user 消息。`transportGeneration` 区分同一 Monitor 的不同连接，`previousRequest` 仅串联同一 transport 的先前请求；重建连接会重置该引用。服务端驻留会话仍可能保有此前已提交媒体和回复历史，不能把模型看到的全部上下文等同于当前这一个 WAV；排查时需要结合前序请求和 transport。
- 每个 `request.json.session` 是为了单独查看文件而附带的初始化快照，不表示本轮重发了系统 Prompt 或任务文本。同一 transport 的快照中事件 ID 保持相同；本轮实际增量发送看 `events`：媒体 append、commit，收到 commit 确认后再发送 `response.create`。只有建立新 transport 才重新发送初始化，任务文字只随该连接的首次媒体推理请求提交一次；系统 Prompt 保持在初始 `session.update` 中。
- 合法的 `providerSessionId` 在可用时写入对应 transport 的 request／response JSON；`response.json` 保存原始动作文本、解析结果，并在服务端提供时保留 `responseId`、`eventId`、`usage`。请求事件也保留可用的发送事件 ID。字段缺失不应由分析者猜补，服务端 usage 也不等于有效麦克风时长。
- 对照 Host、daemon 和 `proactive.monitor_image_sent` 的 `frameHash`；`proactive.monitor_commit` 的计数只包含成功 socket 写入，`proactive.monitor_committed` 对应服务端确认。队列中或已丢弃的帧不能当作已发送证据。
- `proactive.monitor_chunk_prepared` 记录片段采集时间范围和真实发送帧数；`proactive.monitor_chunk_dropped` 记录缺图、采集间断、未提交片段失效或媒体／commit 发送不确定等原因。`proactive.monitor_input_dropped` 聚合本地缓存淘汰的数量、字节和时间范围。上述事件在 debug 模式下进入会话 JSONL，帮助区分“没有完整输入”和“模型判断为 wait”。
- `proactive.monitor_ready` 标注输入通路为 `streaming_buffers`；`proactive.monitor_response_requested` 的 `taskTextIncluded` 只在每条连接的首次媒体推理时为 true，用于区分一次性的任务文字与固定的系统 Prompt。
- 所有模态共同保留最近创建的 **10 个 Monitor 目录**，不是每种模态各 10 个，也不是只保存 10 次请求或限制总磁盘用量。被移出归档的任务继续运行但不再归档。目录／文件使用私有权限，待处理和排队写入有 32 MiB 预算；磁盘错误或超预算可能令归档不完整，但不应因此中断通话。
- JSON 会清理连接凭据字段与已知 API key，但真实声音、画面和用户文字中的其他秘密不会自动脱敏。共享前必须检查 WAV、JPEG 和 JSON，不要只检查终端日志或直接发送整个数据目录。

#### 调度决策与会话 JSONL

媒体归档只说明实际送入某次推理的内容；冷却期间没有送入 Monitor 的音频不会出现在 WAV 中。以 debug 启动时，关键 Proactive 元数据还会同时打印到终端，并保存到 `<dataDir>/sessions/` 下的会话 JSONL，记录的 `type` 为 `proactive.debug`，`payload.event` 为具体事件名：

- `proactive.monitor_commit`／`proactive.monitor_committed`／`proactive.monitor_result`：对应输入提交、服务端确认和推理结果。
- `proactive.evaluation_decision`：例如 `notification_accepted`、`suppressed_awaiting_false`、`rearmed_false`、`ignored_cooldown`，用于区分“模型触发了”与“调度器允许通知”。
- `proactive.cooldown_started`／`proactive.cooldown_resumed`／`proactive.cooldown_audio_dropped` 和 `proactive.buffer_reset`：说明冷却、期间丢弃的音频统计及待提交缓存清理，不是另外保存了被丢弃的原始声音。

关联时先匹配 `taskId` 和任务代际（Monitor 事件为 `taskGeneration`，部分调度事件为 `generation`），再对照相邻 Monitor 结果的 `evaluation`、`transportGeneration` 及可用的 `providerSessionId`／`responseId`。并非每一条调度事件都带全套标识；不能仅靠接近的时间戳混合不同任务或不同连接。该 JSONL 通道保存有界诊断元数据，不保存逐帧音频／图像，也不会追补 debug 开启前的原始内容。

详细实现见 [`monitor-debug-store.ts`](src/proactive/monitor-debug-store.ts)。Host 自身的私有故障日志与设备诊断见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md#日志与文案)。

## 打包与发布

根 workspace 是私有包，实际 npm 包是本目录的 `qwen-live-harness`。发布产物包含构建后的 `dist` 和许可证，不包含 Electron Host；`npm run check:package` 验证这一边界。

公开 npm 包与签名 Host 需要匹配版本和协议。构建、签名、公证、GitHub Release、OSS 同步及 npm 发布的维护入口见 [Host 开发指南](../qwen-live-harness-host/README_ZH.md)；日常源码调试不需要发布或修改安装器信任规则。

许可证：[Apache License 2.0](../../LICENSE)。
