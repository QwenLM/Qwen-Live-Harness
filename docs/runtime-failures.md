# 运行错误与诊断指南

本文面向开发者，说明错误归属、影响范围、诊断证据与恢复边界。主会话对响应确认／取消状态失步提供有限恢复；Monitor 回收、Memory HTTP 重试和 Host 界面恢复各有独立条件。**并非所有网络错误都会自动重连，也不会自动重试已执行的工具。** 麦克风静音心跳用于连接保活。

不是所有失败都会关闭应用。应区分单次操作、一个回答、一个子任务、某项功能、当前通话，以及整个 daemon 进程。通话结束后普通后台 Harness 任务可能仍在执行，不能因为UI停止播报就认定文件修改或命令也停止了。

## 1. 去哪里看日志

`<dataDir>` 默认是 `~/.qwen-live-harness`，可由 `QWEN_LIVE_HARNESS_DATA_DIR` 覆盖。

| 日志                  | 位置                                                  | 内容与保留方式                                                                                                                                                |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话事件 `SessionLog` | `<dataDir>/sessions/live-*.jsonl`                     | 会话、工具、回答、后台事件，以及已接入的 `failure` 记录；默认每 32 MiB 轮转为 `.1`、`.2` 等。一个事件文件不应被假定为只对应一个 `callId`                      |
| 常态运行错误          | `<dataDir>/logs/runtime-errors-<时间>-<随机ID>.jsonl` | 错误专用 JSONL，启动前后及退出阶段也可使用；当前文件达到 1 MiB 前轮转到同名 `.1`。每个实例使用独立文件，多次启动的整个目录并非总共只保留两份                  |
| Host 常态错误         | Electron `userData/logs/host-errors.log`              | 精选设备、权限、连接、renderer 等故障事件；当前文件和 `.1` 各最多 1 MiB，独立于 daemon 日志格式                                                               |
| Debug 运行归档        | `<dataDir>/debug/run-*`                               | 模型 wire 请求／响应、媒体和运行／控制事件；默认每次 512 MiB，保留最近 10 次已结束归档，活跃归档不清理                                                        |
| Monitor 媒体归档      | 系统临时目录 `qwen-live-harness-monitor-debug/`       | 仅 debug 开启时记录逐轮 JPEG／WAV／JSON；跨模态共同保留最近 10 个 Monitor，见 [Monitor 诊断归档](../packages/qwen-live-harness/README_ZH.md#monitor-诊断归档) |

macOS 的 Host 日志默认位置通常是：

```text
~/Library/Application Support/qwen-live-harness-host/logs/host-errors.log
```

Host 的实际位置以 Electron `app.getPath('userData')` 为准。日志目录／文件使用私有权限检查；不能安全打开或写入时会跳过记录，而不是因此中断音视频。

**常态错误文件不要求 `--debug`。** 需要更详细的协议、Proactive 决策或媒体证据时，才另外使用：

```sh
qwen-live-harness --debug
```

源码运行时，在仓库根目录使用：

```sh
npm start -- --debug
```

不要只截取最后一行“failed”。优先保留同一 `callId`／`epoch` 周围的 `response.done`、`tool.call`、`tool.result`、`failure` 与必要的 Host 事件。分享前检查内容：会话事件和媒体归档可能包含私人对话、声音、画面与任务文字。

`--debug` 还会把 `realtime.protocol` 写入同一会话 JSONL，而不仅打印在终端。它记录入站响应、工具生命周期以及出站 `client.response.create`／`client.response.cancel`／工具回执的事件 ID、调用 ID 和等待状态。最终 `response.done` 的工具清单只保留有界的 ID、名称、状态和参数长度；不记录协议原包、Prompt、工具参数正文或音视频。可据此将实际发出的回执与服务端收到的 `event_id` 对齐，不能拿 `tool.result` 的本地执行完成时间代替 socket 发送证据。

上述是 `realtime.protocol` 摘要通道的范围，不代表独立 debug 运行归档也省略正文。`<dataDir>/debug/run-*` 中的 `events.jsonl` 与 `media/` 记录实际观察到的模型消息、Prompt、Memory 上下文、工具参数／结果和媒体。已知凭据会脱敏，但私密声音、画面、业务信息与对话不等于匿名数据。运行归档与临时目录中的 Monitor 归档分别保留；前者默认每次 512 MiB、最近 10 次已结束运行，活跃运行受保护，目录数可能暂时超过十个。

排查时先看 `manifest.json` 的状态、警告和计数，再按 `globalSeq`／`connectionSeq` 关联连接。`wire.send` 只表示尝试写入；对应 `wire.send_result: sent` 表示本地 socket 接受，不代表服务端 ACK，`failed_or_uncertain` 或缺少发送结果更不能证明没有副作用。`archive.connection_registered`、配置／会话快照不是新的模型请求。媒体引用中的相对路径、偏移、长度和 SHA-256 用来校验原始字节。丢事件、容量上限、文件缺失或存储错误都可能令归档不完整，甚至阻止 manifest 更新；同时检查前台警告，不能拿不完整归档证明某件事没有发生。

仓库根目录运行 `node scripts/replay-live-debug.mjs /path/to/debug/run-example` 可离线检查；增加 `--connection conn-000001 --output /path/to/new-export` 可导出指定连接的请求、响应与媒体，输出目录必须新建且位于原归档之外。默认摘要不打印私密正文，导出文件则包含原始私密数据。该工具**不联网、不执行记录里的工具或后台命令**，也不保证重现服务端随机结果；用法见[运行归档与离线检查](../packages/qwen-live-harness/README_ZH.md#运行归档与离线检查)。

### Semantic VAD 的单轮拒绝

音频的 `conversation.item.created` 可能在用户还说话时就到达，不能用它代替 `input_audio_buffer.committed`。主会话只在真实 commit 确认后请求回答。

对于明确的 `Input speech was not accepted by semantic turn detection`，客户端记录非 fatal 的 `semantic_turn_rejected`，不直接结束通话。若可关联到唯一待创建响应，只释放该请求及其超时等待；截图或后台工具已经执行过时，不撤销原用户回合、不重复执行工具、不清空正在采集的新音频。若没有响应请求、也没有已提交输入，但存在唯一未提交的语音候选，则只丢弃该候选、释放等待状态，并忽略其迟到转录／commit。关联不明确时不猜测要清理哪个请求。认证与其他配置错误不适用这条规则。

调试事件 `response.semantic_turn_rejected` 会记录服务端错误 event ID、被引用的出站 event ID、客户端待处理 request ID 和匹配结果。`unacknowledged-<requestId>` 是被拒请求的本地结束标识，不是服务端 response ID。这项兜底让下一轮可以继续交互，不代表被拒绝的那次回答已经成功，也不保证消除服务端拒绝本身。

`remain_silent` 的回执同样先完成一次不播声音、没有工具执行权限的续答，以免服务端把下一句用户问题用于回答旧回执。若这次收尾再次生成工具，客户端以 `silent_receipt_tool_loop` 触发有限 transport 恢复，不执行那个工具，也不无限发送新回执。独立通知音频须等这些主会话收尾完成后才能播放。

### 麦克风静音与连接保活

麦克风处于静音状态时，主 Realtime 每隔 30 秒发送一次 1 秒长的零值 PCM16／16 kHz 单声道音频（32,000 字节），仅发送 `input_audio_buffer.append`，不主动 commit、创建回答或取消播报。它绕过真实麦克风输入分发，不提供给 Monitor 或 Memory，也不计作真实用户发言。解除静音、结束通话或连接终止时停止；仅关闭扬声器不会启用该心跳。

会话 JSONL 中的 `audio.input_mute_changed` 记录静音切换和初始化状态；`audio.input_heartbeat` 记录成功发送的心跳、provider Session ID 与出站 event ID，不记录音频内容。缓冲背压导致心跳跳过时记录 `input_heartbeat_backpressure`，不会仅因丢掉这段静音终止通话；真实发送异常仍按连接错误处理。

如果静音之前已有真实的未完成发言，心跳静音可能帮助服务端 VAD 结束那段发言；客户端不伪造 VAD 事件。服务端的内部错误或超时仍可能断开连接，心跳不能保证消除所有 `1011`。排查时对齐静音、心跳、最后一次响应与服务端关闭原因，不应直接将所有断连归因于静音。

## 2. `failure` 记录如何读

Daemon 的规范错误记录使用以下核心字段：

| 字段         | 含义                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `source`     | `realtime`、`host`、`tool`、`backend`、`proactive`、`memory` 或 `daemon`                                          |
| `code`       | 稳定的本地错误码，或可用的供应商错误码；没有可用值时使用受控的缺省值                                              |
| `stage`      | 发生阶段，例如 `connect`、`arguments`、`handler`、`function_call_output`、`audio_input`、`cleanup`                |
| `impact`     | `operation`、`response`、`task`、`feature`、`call` 或 `daemon`；表示记录该故障时的影响范围，不是恢复指令          |
| `message`    | 有长度限制并经过脱敏的说明                                                                                        |
| 可选关联标识 | `epoch`、`callId`、`providerSessionId`、`responseId`、`toolCallId`、`toolName`、`taskId`、`backend`               |
| 可选诊断字段 | `errorName`、`kind`、`providerType`、`param`、HTTP `status`、WebSocket `closeCode`、`fatal`、`executionUncertain` |

`kind` 的 `configuration`／`quota`／`transient`／`protocol` 是错误分类，部分依据供应商代码、状态和文本推断。**`transient` 不等于可以安全重试，`fatal:false` 也不等于这次操作成功。** `fatal` 需要结合来源理解：独立搜索或 Monitor 的连接失败不一定意味着主会话失败。

`quota` 用于服务商配额不足或超限，例如 `insufficient_quota`／`quota_exceeded`。它与暂时网络故障分开处理；排查账户额度、地域和并发会话，不能通过重连循环规避。服务端关闭原因中的配额信息应保留，不能仅归并成一般的未确认输入丢失。

`executionUncertain:true` 尤其重要：超时、发送确认丢失或回执序列化失败，都不能证明工具没有执行。反过来，这个字段缺失也不是“已确认没有副作用”。

合成示例，展示运行错误文件的外层结构：

```json
{
  "ts": 0,
  "seq": 1,
  "pid": 12345,
  "type": "failure",
  "payload": {
    "source": "tool",
    "code": "tool_timeout_pending",
    "stage": "handler",
    "impact": "operation",
    "message": "The tool response timed out; execution may still continue and must not be retried automatically.",
    "callId": "call-demo",
    "responseId": "response-demo",
    "toolCallId": "tool-demo",
    "toolName": "handoff",
    "executionUncertain": true
  }
}
```

SessionLog 的外层仍是 `ts`、`seq`、`type`、`payload`，不要求存在 `pid`。Host 的 `host-errors.log` 则使用 `timestamp`、`source: "qwen-live-harness-host"`、`event` 和精选白名单字段，**不是上面的同一种 schema**。

新记录会过滤未允许的字段、已知凭据、常见认证内容及控制字符，记录结构不直接接收原始函数参数、headers、媒体或完整 stack。脱敏不等于匿名化：说明文本仍可能含文件路径或业务错误片段，分享前仍需检查。它不替代所有既有日志：`error`、`response.done`、`proactive.debug` 等仍然保留，也不能把历史会话日志一概当作已全面脱敏。

## 3. 主 Realtime 错误矩阵

表中的“代码／现象”包括规范 `failure` code、客户端现有错误码和供应商错误；不表示每一行都已经统一为一种本地 code。

| 来源／类别         | 代码或现象                                                                          | 当前影响与处理                                                                                                                                        | 排查与重试边界                                                                     |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 配置与初始 prompt  | `invalid_endpoint`、`instructions_too_large`，认证／模型／参数的 400、401、403、404 | 连接无法建立，或配置类错误使当前通话失败；可将 provider 标记为配置不可用                                                                              | 指明需修正的字段；只对明确可修的参数进行有上限的纠正，不原样无限重连               |
| 建连与网络         | `connection_failed`、`connection_timeout`、`socket_error`、`http_<status>`          | 主连接失败；建连默认 8 秒超时                                                                                                                         | 核对连接、地域与认证状态；进入交互后先核对执行状态，不自动重放可能有副作用的请求   |
| 发送失败           | `send_failed`、`function_output_send_failed`                                        | 主连接结束；失败前的数据或工具可能已经被服务端接受                                                                                                    | 不重发可能有副作用的工具或权限票；先依据会话、call ID 和后台 job 记录核对          |
| 顶层供应商错误     | WebSocket `type: "error"`，包括 unknown `call_id`、无效参数、限流等                 | 默认按 fatal 处理；精确匹配待确认工具回执的 unknown call ID 转为 `tool_output_rejected`；明确的 semantic VAD 拒绝按上节 `semantic_turn_rejected` 处理 | 不能把未关联错误猜成某个工具失败；不得换 ID、重复执行或重放权限票来“修复”          |
| 单轮回答失败       | `response.done` 的 `status: "failed"`，`response_failed` 或供应商 code              | 没有待确认语音丢失时，报告非 fatal 错误，主连接可继续；已经执行的工具不一定取消                                                                       | 明确告知该轮失败；必要时重新组织回答，但不得重放该轮的 mutation                    |
| 输入转录失败       | `conversation.item.input_audio_transcription.failed`                                | 若仍有未解决输入，可能升级为 `unrecoverable_input`；否则只报告非 fatal ASR 错误                                                                       | 区分“回答已完成但转录缺失”和“整句话未被可靠接收”；后者引导用户重说，不编造缺失文本 |
| 未确认语音丢失     | `unrecoverable_input`                                                               | 结束通话；部分原始网络错误会被这个更保守的错误取代                                                                                                    | 保留底层原因与输入状态用于诊断；不要宣称可以透明恢复尚未可靠保存的音频             |
| 响应确认／取消超时 | `response_created_timeout`、`response_done_timeout`、`response_cancel_timeout`      | 主会话进入下文的有限 transport 恢复；direct 开始确认也有 15 秒期限，取消宽限期 2 秒                                                                   | 不将恢复扩大为已执行工具的重试；其他完成／网络失败需分别判断                       |
| 服务端关闭连接     | `connection_closed`，附 `closeCode`                                                 | 非本地主动关闭时结束当前通话；部分重启／异常 close code 归为 transient                                                                                | 新连接与旧调用状态隔离；不能把正常数值 close code 当成“先前动作没有发生”           |
| 本地回调抛错       | `callback_failed`                                                                   | 经 fail 路径终止主会话，副作用可能已经发生                                                                                                            | 先修复具体回调与错误边界，不把它当纯网络抖动进行重连循环                           |

普通传输错误被升级成 `unrecoverable_input` 时，代码会保留原始 cause，并另外记录 `stage: provider_cause`。下面的响应状态恢复不经过这条全局失败路径。

当前通话清理会取消本通话的原生搜索、请求停止自动转交查询、关闭 Monitor，并结束 Memory attachment。后台查询是否确实停止仍应以后端回执为准；**普通已委托的 Harness 工作也不因此获得回滚保证。**

### 响应确认与取消状态恢复

所有客户端创建的响应，包括普通用户的 `direct` 回答，都有默认 15 秒的 `response.created` 确认期限。用户打断尚未确认的响应时，最多等待 2 秒取消宽限期；没有响应 ID 时不发送 `response.cancel`，因为当前 API 会拒绝这种取消。已有响应 ID 才取消，并等待结束确认。

超期后，默认主会话的恢复包装层先隔离旧 transport，再建立新连接，每次逻辑通话最多尝试两次替换连接。迟到的旧响应、音频和工具调用不能被关联到新请求。恢复不结束 Host 通话，不重启后台 Harness、Monitor 或 Memory；未完成的主动通知保持 FIFO，恢复上下文先包含当前有效权限和任务状态，再处理新的用户输入。用户答复绑定原输入所对应的权限 ID；旧请求失效后，恢复的“允许”不能批准重连中新出现的请求，需要重新询问并获得新的用户答复。

只有尚未执行工具的最新用户输入可以恢复：优先使用完整 ASR；没有 ASR 时，仅使用具有可信起点、未被截断的真实麦克风缓存（上限 60 秒）。静音心跳不进入缓存。已经派发工具的旧请求不重播，旧工具回执也不发到新连接；后台任务继续通过自身状态事件报告结果。输入边界不可信时不猜半句话，界面提示用户重新说。恢复期间的新音频同样受大小限制。

`transport.recovery_started`／`transport.recovery_completed` 等元数据位于 `realtime.protocol` 中，并记录代次、原因和输入种类。若两次替换均失败、缓冲超限或上下文无法安全恢复，仍会明确结束这次交互并提示重试，而不是无限循环。一般网络断开、认证错误和 `Unknown function call id` 不会因此自动重试；准确关联待确认回执的 Unknown 错误保留原连接并停止该工具续答链，不建立新连接或重跑工具，未关联错误按其错误分类处理。非 direct 的完成等待仍有 120 秒上限，direct 的完成等待不是固定 120 秒总时长。

### 协议完整性与本地边界

下列客户端协议错误当前通常关闭主连接：

- 入站封装：`unexpected_binary_message`、`message_too_large`、`invalid_provider_message`。
- 输入／转录关联：`invalid_input_item`、`unattributed_final_transcript`、`ambiguous_final_transcript`、`ambiguous_input_transcript`、`too_many_pending_inputs`、`transcript_too_large`。
- 输出：`invalid_response`、`invalid_audio_frame`、`text_delta_too_large`。
- 函数调用流：`invalid_function_arguments`、`function_arguments_too_large`、`too_many_function_calls`、`ambiguous_handoff`。最后一个名字虽然含 handoff，实际也会检查其他已经 dispatch 后又变动参数的调用。

工具执行另有非 fatal 的最终快照校验：只有父 `response.done` 和每个函数项均为 `completed`、调用 ID／名称／最终参数彼此一致时才派发。部分、矛盾、重复或缺失的最终函数清单触发 `invalid_function_completion`，该响应的工具全部不执行；取消或失败的响应同样不派发工具。不能用较早的增量事件或 `arguments.done` 代替这个最终确认。

相关保护上限包括：入站消息 1 MiB、待跟踪输入 32 项、函数分发前检查待执行调用与待确认回执合计不超过 8 项、函数参数 32 Ki 字符、函数结果 64 Ki 字符。这些协议上限不等于“只能创建 8 个后台子智能体”。

另有本地 `RangeError`／`false` 返回：instructions 超过 100,000 字符、非法 PCM／JPEG、上下文／播报／repair 参数越界等。它们本身不一定关闭 socket，影响由调用方决定。例如：

- 麦克风空帧返回 `false`；奇数字节或超过 64 KiB 的帧抛错，上层可能失败结束通话。
- 未开始输入音频、图像过期或图像发送被拒绝，可只丢弃该帧，不等同于主会话中断。
- 某些通知注入捕获异常后仅返回 `false`，可能表现为通知延后或未播报，而非显式断线。
- 重复／迟到的协议事件有些会被忽略；合理的旧事件丢弃与真正的协议损坏应分开分析。

对于关联歧义、函数参数被更改等错误，建议先保留现场并修复协议对齐，不为了“继续聊天”跳过身份校验。

## 4. 工具与后台执行矩阵

| 代码或现象                                            | 当前影响与处理                                                                                                                                                                | 重试边界                                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_unknown`                                        | 返回未知工具错误回执，不调用 handler                                                                                                                                          | 不自动猜测另一个工具或绕到 Harness；先修正工具声明与模型调用                                                                                   |
| `tool_arguments_invalid`、`tool_arguments_shape`      | 执行前拒绝无效 JSON、空字符串／纯空白和非对象参数，返回 `status: "error"`、`code: "invalid_arguments"`，不调用 handler；显式 `{}` 仍是合法空参数                              | 本次拒绝未执行工具；不猜测缺失参数或自动降级为 `{}`。由模型依据原始用户请求纠正，不能编造任务信息                                              |
| `tool_handler_failed`                                 | handler 异常转成错误回执；不能保证先前副作用回滚                                                                                                                              | 核对任务、文件或服务实际状态，再决定是否重试                                                                                                   |
| `tool_result_serialization_failed`                    | handler 已返回，但结果不能序列化，转错误回执                                                                                                                                  | 标记执行不确定；不能重新调用同一个 mutation 来换取可用回执                                                                                     |
| `tool_timeout_pending`                                | 默认 30 秒返回 `status: "pending"`；handler 继续运行，不自动取消                                                                                                              | 等待真实后台状态，禁止立即重试 handoff／授权／文件或命令操作                                                                                   |
| `tool_business_rejected`                              | handler 正常返回 `status: "error"`；`ToolDispatchResult.ok` 仍可能是 `true`，它只表示调度层返回                                                                               | 同时看业务 status 与诊断，不把调度层 ok 当业务成功；只对明确无副作用的错误考虑纠正                                                             |
| `tool_output_too_large`                               | 超大回执被替换为有界错误回执，操作可能已经完成                                                                                                                                | 保留后台结果入口，不重复执行来缩短输出                                                                                                         |
| `invalid_function_completion`                         | 最终函数快照不完整、矛盾或重复，报告非 fatal 错误；该响应的所有工具均不执行，不向无效 call ID 回传结果                                                                        | 不从部分参数猜测用户意图，也不自动重建或重跑工具；取消／失败的父响应也不能授权执行                                                             |
| `tool_output_rejected`（已关联的服务端 Unknown 错误） | `Unknown function call id` 的 call ID 或 `error.event_id` 精确匹配待确认回执：非 fatal、保留原 socket；停止该工具续答链，以静默 `[TOOL_OUTPUT_STATUS]` 传入本地结果和拒绝状态 | 不自动重跑、重发回执或创建替代 call ID；本地执行可能已经发生，不能把回执被拒绝说成工具没执行。未关联供应商错误与本地提交失败仍沿用原有错误处理 |
| `tool_output_ack_timeout`                             | 已发送工具结果默认 10 秒内未收到匹配的完成回执：非 fatal、保留原 socket；清理等待并停止该工具续答链，以静默 `[TOOL_OUTPUT_STATUS]` 记录未确认状态                             | 不自动重试执行或续答，不宣称服务端收到结果；新的用户输入和其他独立通知可继续。迟到确认不会恢复已终止的续答链                                   |
| 后台任务自身失败／授权拒绝／backend 不可用            | 主要影响目标任务或操作；错误仍可能沿用 `backend.event`、`error`、业务回执等既有记录                                                                                           | 默认 backend 预检失败可阻止启动；次要 backend 失败不必令主对话失败。权限拒绝不能作为换后端绕过限制的理由                                       |

业务 `note`、异常文本和完整结果按回执语义处理；统一诊断输出受控摘要和允许的字段。日志观察者抛错被隔离，不应改变 handler 调用次数、`ok`、回执或超时后的执行状态。

## 5. Host、设备与进程矩阵

| 来源／代码或 Host event                                                                                               | 当前影响与处理                                                                                | 排查与重试边界                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 麦克风无设备、权限／采集超时、`audio_input_rejected`、`audio_input_failed`                                            | 可能阻止通话开始或结束当前通话；主输入背压不会被当作无声丢帧忽略                              | 检查可用输入设备和系统权限；输入链路失败不能当成完整发言，不能假定会自动切换为文本交互 |
| 输出设备／播放故障、`audio_output_unavailable`、`audio_output_backpressure`、`audio_output_send_failed`、结束标记失败 | 可能丢失或中断该次播报；某些进一步异常也会导致通话失败                                        | 核对可见结果、未播报状态与设备回执；不要在未确认播放进度时整段重复播放                 |
| 相机／屏幕权限、截图超时或无效帧                                                                                      | 单次截图／视觉功能失败，某些 readiness 丢失也会结束当前通话                                   | 明确没有取得当前画面，检查所选来源与权限；不能以缓存帧冒充新画面                       |
| Host 身份、版本、lease 或协议错误                                                                                     | `host_identity_rejected`、`host_lease_active` 等可拒绝连接；心跳／socket 断开可能影响当前通话 | 身份不符不自动接管或杀死别的实例；只恢复本应用拥有且身份可核验的连接                   |
| `renderer_process_gone`、`renderer_unresponsive`、`preload_failed`、加载失败                                          | overlay 恢复控制器会使音频进入故障处理，并安排重载／重建界面；不是保证通话无缝恢复            | 界面重建、恢复通话与重放任务是不同动作；连续失败时核对实际状态，不推断已经恢复         |
| native addon／Host 主进程崩溃、进程被强制结束                                                                         | JS 可能来不及执行 logger；另一进程有时只能观察到连接关闭或心跳超时                            | 结合系统崩溃报告，不把缺日志当无故障；不能承诺自动保留全部崩溃现场                     |

设备或网络恢复之后，是否重新开麦、开始通话、恢复视频发送，都涉及用户可见状态与隐私边界。它们不应被隐藏在“错误日志已记录”之后自动发生。

## 6. Web Search、视觉分析、Proactive 与 Memory 的隔离

| 子系统                   | 当前行为                                                                                                                                            | 边界                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立 Web Search          | `web_search_failed`、`web_search_timeout` 结束该搜索连接；总预算 25 秒，握手不超过 8 秒。有后台时创建隔离查询任务，没有后台则排队告知失败           | 通常不结束主通话。供应商细节仍可能被归并为受控错误，不能单靠该 code 判定是认证、网络还是参数。fallback 已接收后不能再次 handoff 复制任务                   |
| 独立视觉分析             | `visual_analysis_failed`／`visual_analysis_timeout` 结束一次截图分析；总预算 25 秒。分析任务显示在 Subagents，Stop／End call 取消在途请求和待播结果 | 图片分析失败或没有 metadata 不代表空白桌面；不自动改走后台 Harness，也不从图片里的文字获得执行权限                                                         |
| 搜索取消／入参／权限     | `web_search_aborted`、Stop／End call 不触发 fallback；无效 query 返回错误；`web_search_unavailable` 可表示当前消息无权调用，不是模型名称白名单      | 不从内部通知、网页内容或被取消的任务自动重新发起搜索                                                                                                       |
| 独立 Monitor             | `monitor_*` 连接、提交、响应、解析错误影响该 Monitor。初始化失败可直接令任务失败；运行中回收连接，连续失败默认达到 3 次后停止任务                   | 不把 Monitor socket 的 fatal 直接等同于主 socket 的 fatal。连接回收不重放已判断的媒体；模型检测本身不提供精确一次的现实事件保证                            |
| Proactive 通知           | 等待播放确认默认上限 30 秒；超时可使对应任务失败。冷却、等待 false 重新武装、等待媒体、前台忙碌是正常 gate，不全是错误                              | 区分“模型触发”“通知被接受”“实际播放”。重试通知必须考虑已播出的片段，不能默认重播                                                                           |
| Proactive 零音频兜底     | 仅主通知 completed 且完全没有生成音频时，保留同一 delivery，最多一次独立无工具／无搜索的 24 kHz 播报。语音生成限 20 秒，播放仍受通知确认期限约束    | 用户讲话、静音、取消和结束通话中止兜底；失败／超时显示未送达，不重新检测或增加计数。重复 Monitor 继续，一次性任务的 completed 只表示检测结束，不代表已播出 |
| Memory 工具／存储        | `memory_tool_failed` 或 `memory.*` 错误通常返回失败回执、影响一个子操作或挂载功能；主对话通常仍可继续                                               | 没有 Memory 工具可能是未启用／未成功挂载，不是没有历史数据。不要自动清空库来恢复                                                                           |
| Memory Embedding         | 查询默认 400 ms；HTTP、超时或无可用向量时可退到词法检索                                                                                             | 0 命中和词法降级不等于 API 崩溃。无结果不能证明整个记忆库为空                                                                                              |
| Memory Observer／Updater | Observer 失败可等后续采样；Updater 可能为 `failed`、`empty` 或 `skipped`。HTTP 客户端至多进行一次网络／429／5xx 重试，共用原超时预算                | 整理未完成不应阻断普通回答；WM 更新成功不代表 LTM 已整理成功。重做 `omnibio.update/delete` 前必须重新核对当前索引                                          |
| Monitor 归档写入         | 初始化、磁盘、权限、预算或淘汰失败只影响诊断归档，记录可能不完整                                                                                    | 不应为了“有录像”改变通话行为；未记录的旧音频不能追补                                                                                                       |

这些隔离都有边界：独立子系统完成后仍需要主 Realtime 播报，而主连接在播报时遇到 fatal provider 错误，仍可结束当前通话。不能把“搜索计算独立”理解成“结果播报永远不会受主连接故障影响”。

## 7. 启动、退出和日志自身失败

| 代码或现象                                                                    | 当前含义与影响                                                                                                                               | 处理边界                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `configuration_load_failed`                                                   | 配置缺失、格式或字段校验等问题导致 CLI 无法正常启动                                                                                          | 修正明确字段；保留原文件和用户模型别名，不擅自重新 init 覆盖           |
| `runtime_missing`／`runtime_invalid`／`runtime_unavailable`、`config_missing` | 桌面启动登记、Node／CLI 路径或初始化条件不可用                                                                                               | 引导修复安装／登记，不下载或执行来源不明的替代运行时                   |
| `discovery_invalid`、`daemon_mismatch`、`daemon_unresponsive`、`startup_busy` | 已有实例或 discovery 无法被安全使用                                                                                                          | 核对进程身份与所属目录；不把无法确认的实例当成本应用可以强杀的子进程   |
| `daemon_start_failed`、`application_start_failed`、`startup_timeout`          | 启动中的具体阶段失败；daemon 日志会带 `stage`，如 `backend_preflight`、`memory_initialization`、`host_initialization`、`listen`、`discovery` | 优先修复对应阶段，不把所有情况统称“模型连不上”                         |
| `startup_aborted`、正常 SIGINT／SIGTERM                                       | 用户或上层要求停止可能是预期流程                                                                                                             | 不当作自动重新启动的理由                                               |
| `cleanup_failed`、`process_shutdown_failed`、`startup_cleanup_failed`         | 退出清理没有全部完成，资源或后台工作状态可能不确定                                                                                           | 确认具体自有资源后再重试清理，不能只隐藏UI就宣布后台全部停止           |
| `unhandled_rejection`                                                         | 后台 promise 拒绝处理器记录诊断；当前不因此自动退出进程                                                                                      | `impact: operation` 不代表整个应用仍健康，也不是成功恢复；需查具体状态 |
| 日志目录不可写、磁盘满、unsafe path 或写入失败                                | RuntimeFailureLog 返回失败，daemon 可发一次警告；SessionLog／Host 日志采用 best-effort 隔离，部分记录会缺失                                  | 不递归记录“日志写失败”造成错误风暴，也不让 logger 本身中断通话         |

同步写入错误文件能减少退出时丢日志，但没有把每条记录都变成强制持久化事务。**SIGKILL、断电、系统冻结、OOM、原生崩溃或存储故障下，日志完整性均无法保证。** 缺少最后一条错误日志不能证明是正常退出。

## 8. 错误处理的安全边界

- **失败不等于未执行。** 超时、Unknown call ID、回执丢失和进程断开都可能发生在副作用之后；先核对后台 job、权限票和实际资源状态，不自动重试文件写入、命令或 Memory 索引修改。
- **状态以正确层级为准。** 模型触发、任务受理、生成文本、音频转交和设备播放完成各有独立状态；不能用任务 completed 代替播报 delivered，也不能把 logger 成功当作操作成功。
- **恢复只恢复被允许的状态。** 有限 transport 恢复保留原模型、地域和身份约束，只恢复有可靠边界、尚未执行工具的输入；不会透明重放已经派发的工具或权限决定。
- **媒体状态必须可见。** 没有新画面时不能用缓存帧冒充当前画面，输入缺帧不能当作完整发言。设备恢复、切源和权限变化由明确的生命周期控制，不因为写入了一条错误日志就悄悄发生。
- **停止优先。** Stop、Quit、任务取消和通话代次变化使对应排队事件、迟到结果与恢复尝试失效；不能重新启动已经被用户停止的工作。
- **保留证据，不扩大权限。** 默认诊断不执行工具；离线导出不联网、不模拟用户授权。归档缺失或不完整时保留不确定性，不凭猜测填补事实。

系统不提供全局无限重试、任意媒体自动降级或后台任务的 exactly-once 保证。独立功能的有限重试、fallback 和恢复条件以各节的具体规则为准。

## 9. 覆盖边界与源码入口

诊断包括统一 `failure`、`error`、`response.done`、子系统 debug event、布尔拒绝、正常取消和有意忽略的迟到事件；某些本地校验没有独立稳定 code。规范记录可能在不同层出现多个影响范围，应该按关联标识阅读，不把日志条数当故障次数。

主要入口：

- [规范错误记录与常态文件](../packages/qwen-live-harness/src/log/runtime-failure.ts)
- [会话日志](../packages/qwen-live-harness/src/log/session-log.ts)
- [主 Realtime 协议与错误边界](../packages/qwen-live-harness/src/realtime/realtime-session.ts)
- [LiveSession 的工具、媒体与通话处理](../packages/qwen-live-harness/src/orchestrator/live-session.ts)
- [ToolDispatcher 的观察性日志](../packages/qwen-live-harness/src/tools/dispatcher.ts)
- [Host 协议协调](../packages/qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts)
- [Host 精选故障日志](../packages/qwen-live-harness-host/src/main/host-diagnostics.ts)
- [启动入口](../packages/qwen-live-harness/src/index.ts) 与 [daemon 资源清理](../packages/qwen-live-harness/src/daemon.ts)

提交问题时请提供版本、操作步骤、真实影响范围，以及同一关联 ID 下经过检查的日志片段。无需也不应默认上传完整会话、Memory 数据库或原始声音。
